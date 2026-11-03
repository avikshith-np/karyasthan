// 015 Director as god, P1 (plan §1.2, §1.4, §P1.1–§P1.9) — the opened owner
// powers through the live Director (preview → apply): the appendEvent rules of
// the god types, money, career (fire → out of work, hire, refusals), relaxed
// refusals for a hand-built preview vs a prompt draft (pins, romance slot, stage
// jump) and the hard ones that stay (family_romance, chat_plan, use_arc_action),
// picks and outcomes, mood / health scheduling, cast depart / return (ids never
// reused, names still resolve), REVERT THIS CHANGE (whole change, refused when a
// part already happened), the route's shape checks and the prompt side (god kinds
// drafted but never batchable, no employer name, catalogue without chat plans).
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR, DAY,
} from './_helpers.js';
import { appendEvent, getEvent, listEvents, GOD_EVENT_TYPES, CHAT_FORBIDDEN_TYPES } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as promptMod from '../../src/life/story/prompt.js';
import * as store from '../../src/life/story/store.js';
import { getDb } from '../../src/memory/db.js';
import { isExcludedId } from '../../src/life/projector.js';
import { validatePromptOutput } from '../../src/life/story/schema.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';
import { dayType } from '../../src/life/routine.js';
import { worldOverlay, overlayKey, castNameOf } from '../../src/life/story/reducer.js';
import { isChatDecision } from '../../src/life/story/pending.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed 28 Oct, mid-morning
const S = () => life.getState();

async function code(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
async function applyOk(action, opts = {}) {
  const p = await director.preview(action, { relax: true, ...opts });
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, r, events: r.eventIds.map(getEvent) };
}
const evOf = (res, type) => res.events.filter(e => e.type === type);

section('appendEvent rules (plan §1.2)');
{
  const now = clock.now();
  const owner = ['outcome.set', 'career.set', 'self.moved', 'money.adjusted', 'vitals.planned', 'sick.planned', 'cast.departed', 'cast.returned'];
  for (const t of owner) {
    let msg = null;
    try { appendEvent({ type: t, at: now, actor: 'engine', payload: {} }); } catch (e) { msg = e.message; }
    check(`${t}: engine refused`, /only the owner/.test(msg ?? ''), msg);
  }
  check('every god type is chat-forbidden', [...GOD_EVENT_TYPES].every(t => CHAT_FORBIDDEN_TYPES.has(t)));
  let msg = null;
  try { appendEvent({ type: 'outcome.happened', at: now, actor: 'engine', payload: {} }); } catch (e) { msg = e.message; }
  check('outcome.happened needs a cause', /needs a cause/.test(msg ?? ''), msg);
  const money = appendEvent({ type: 'money.adjusted', at: now, actor: 'owner', payload: { mode: 'income', amount: 1 } });
  msg = null;
  try { appendEvent({ type: 'outcome.happened', at: now, actor: 'engine', causeId: money.id, payload: {} }); } catch (e) { msg = e.message; }
  check('…and the cause must be an outcome.set', /cannot be caused by money.adjusted/.test(msg ?? ''), msg);
  msg = null;
  try { appendEvent({ type: 'decision.expired', at: now, actor: 'owner', payload: { decisionId: 1, reason: 'fell_through' } }); } catch (e) { msg = e.message; }
  check('decision.expired fell_through from the owner refused', /must be an engine event/.test(msg ?? ''), msg);
  msg = null;
  try { appendEvent({ type: 'decision.expired', at: now, actor: 'engine', causeId: money.id, payload: { decisionId: 1, reason: 'cast_departed' } }); } catch (e) { msg = e.message; }
  check('decision.expired cast_departed with another cause type refused', /cannot be caused by/.test(msg ?? ''), msg);
  msg = null;
  try { appendEvent({ type: 'decision.committed', at: now, actor: 'engine', payload: { decisionId: 1, optionId: 'go', by: 'owner' } }); } catch (e) { msg = e.message; }
  check('payload by:owner from a non-owner actor refused', /only the owner/.test(msg ?? ''), msg);
  life.revertEvent(money.id, { reason: 'test' });
}

section('money (§P1.3)');
{
  const before = Math.round(S().vitals.money);
  const inc = await applyOk({ kind: 'money', mode: 'income', amount: 1234, label: 'a bonus' });
  check('one owner money.adjusted under the director.action', evOf(inc, 'money.adjusted').length === 1 && evOf(inc, 'money.adjusted')[0].originKind === 'owner');
  eq('income adds exactly', Math.round(S().vitals.money) - before, 1234);
  const set = await applyOk({ kind: 'money', mode: 'set', amount: -50 });
  eq('set is exact at fold time', Math.round(S().vitals.money), -50);
  check('a negative balance warns (money_negative)', (set.p.continuity?.warnings ?? []).some(w => w.code === 'money_negative' && w.severity === 'warn'));
  const r = life.revertEvent(evOf(set, 'money.adjusted')[0].id, { reason: 'test' });
  check('money.adjusted is revertible', Number.isSafeInteger(r.revertEventId));
  eq('…back to before + income', Math.round(S().vitals.money), before + 1234);
  eq('route: a bad mode is refused', actionProblem({ kind: 'money', mode: 'steal', amount: 1 }), 'bad_mode');
}

section('career: fire → out of work, hire, refusals (§P1.2)');
{
  const fired = await applyOk({ kind: 'career', change: 'fire' });
  check('owner career.set {fire}', evOf(fired, 'career.set')[0]?.payload?.reason === 'fire');
  check('job_loss_big warns', (fired.p.continuity?.warnings ?? []).some(w => w.code === 'job_loss_big'));
  check('the story says out of work', S().story.career.employed === false);
  const w = worldOverlay(S(), world);
  check('the overlay: no job, no office, salary 0', w.self.job === null && w.self.employed === false && w.money.salary === 0);
  check('overlayKey is set', overlayKey(S()) !== null);
  // A weekday is "off": find the next Thursday-ish weekday (not weekend).
  const nextWeekday = clock.now() + DAY;
  const dt = dayType(nextWeekday, w, {});
  check(`a weekday is 'off' while unemployed (got ${dt})`, dt === 'off' || dt === 'weekend');
  eq('fire again → refused unemployed', await code(director.preview({ kind: 'career', change: 'fire' }, { relax: true })), 'refused:unemployed');
  eq('promote while out of work → refused', await code(director.preview({ kind: 'career', change: 'promote', salary: 10 }, { relax: true })), 'refused:unemployed');
  const officeId = [...S().places.values()].find(p => p.kind === 'office')?.id;
  const hired = await applyOk({ kind: 'career', change: 'hire', title: 'Analyst', employerName: 'Brightline Works', officePlaceId: officeId, salary: 50000 });
  check('hire → employed again with the new title', S().story.career.employed === true && S().story.career.title === 'Analyst');
  check('…a career.set caused by the parent', evOf(hired, 'career.set')[0]?.causeId === hired.r.actionEventId);
  eq('hire while employed → invalid', await code(director.preview({ kind: 'career', change: 'hire', title: 'X' }, { relax: true })), 'invalid:employed');
  // An applied career change is not revertible (it re-planned days he lived).
  let msg = null;
  try { life.revertEvent(evOf(hired, 'career.set')[0].id, { reason: 'test' }); } catch (e) { msg = e.message; }
  check('an applied career.set cannot be reverted', /cannot be reverted/.test(msg ?? ''), msg);
  // A scheduled one can, while pending.
  const later = await applyOk({ kind: 'career', change: 'salary', salary: 61000, when: { inMinutes: 600 } });
  const sid = evOf(later, 'career.set')[0].id;
  check('a later change is pending', !!S().story.pending?.[sid]);
  const rv = life.revertEvent(sid, { reason: 'test' });
  check('…and revertible while pending', Number.isSafeInteger(rv.revertEventId) && !S().story.pending?.[sid]);
}

section('relaxations: hand-built warns, prompt drafts refuse (§1.4)');
{
  const castId = [...S().cast.keys()][0];
  await applyOk({ kind: 'pin', pinKey: castId });
  const hand = await director.preview({ kind: 'cast.edit', castId, fields: { status: 'busy with a project' } }, { relax: true });
  check('hand-built cast.edit on a pinned member: plans with overrides_pin', hand.refusals.length === 0
    && (hand.continuity?.warnings ?? []).some(w => w.code === 'overrides_pin'));
  const draft = director.plan({ kind: 'cast.edit', castId, fields: { status: 'busy with a project' } }, S(), { now: clock.now() });
  check('a draft (no relax) is refused pinned', draft.refusals.some(r => r.reason === 'pinned'));
  const viaFacade = await story.director.preview({ kind: 'cast.edit', castId, fields: { status: 'busy' } }, { source: 'prompt' });
  check('the facade with source:prompt refuses too', viaFacade.refusals.some(r => r.reason === 'pinned'));
  const handFacade = await story.director.preview({ kind: 'cast.edit', castId, fields: { status: 'busy' } }, { source: null });
  check('…and plans for a hand-built source', handFacade.refusals.length === 0);
  await applyOk({ kind: 'unpin', pinKey: castId });

  // Romance: start one, a second one while it is open, a stage jump, family.
  const ids = [...S().cast.values()].filter(c => !/^family:/.test(c.relation ?? '')).map(c => c.id);
  const fam = [...S().cast.values()].find(c => /^family:/.test(c.relation ?? ''));
  if (fam) eq('romance with family → refused (hard)', await code(director.preview({ kind: 'scene', shape: 'arc.start', category: 'romance', arcKind: 'romance', castIds: [fam.id] }, { relax: true })), 'refused:family_romance');
  const r1 = await applyOk({ kind: 'scene', shape: 'arc.start', category: 'romance', arcKind: 'romance', castIds: [ids[0]] });
  const arcId = evOf(r1, 'arc.started')[0].id;
  eq('a second romance as a draft → romance_active', await code(Promise.resolve().then(() => director.plan({ kind: 'scene', shape: 'arc.start', category: 'romance', arcKind: 'romance', castIds: [ids[1]] }, S(), { now: clock.now() }))), 'refused:romance_active');
  const r2 = await director.preview({ kind: 'scene', shape: 'arc.start', category: 'romance', arcKind: 'romance', castIds: [ids[1]] }, { relax: true });
  check('…hand-built: ends the current one first (warning)', r2.events[1]?.type === 'arc.ended' && (r2.continuity?.warnings ?? []).some(w => w.code === 'ends_current_romance'));
  const jump = await director.preview({ kind: 'scene', shape: 'arc.stage', arcId, to: 'engaged' }, { relax: true });
  check('hand-built stage jump plans with stage_jump', jump.refusals.length === 0 && (jump.continuity?.warnings ?? []).some(w => w.code === 'stage_jump'));
  eq('…a draft jump → not_adjacent', await code(Promise.resolve().then(() => director.plan({ kind: 'scene', shape: 'arc.stage', arcId, to: 'engaged' }, S(), { now: clock.now() }))), 'invalid:not_adjacent');
  // End it (arc.end) so later sections start single.
  const ended = await applyOk({ kind: 'arc.end', arcId, outcome: 'fizzled' });
  check('arc.end ends it (romance cooldown warning)', S().story.arcs[arcId].status === 'ended' && (ended.p.continuity?.warnings ?? []).some(w => w.code === 'romance_cooldown_set'));
}

section('picks and outcomes (§P1.1)');
{
  // An owner outing tonight → a committed decision we can steer.
  const placeId = [...S().places.values()].find(p => p.kind !== 'home' && p.kind !== 'office')?.id;
  const castId = [...S().cast.values()].find(c => !/^family:/.test(c.relation ?? ''))?.id;
  const at = clock.now() + 9 * HOUR;
  const out = await applyOk({ kind: 'scene', shape: 'outing', placeId, castIds: [castId], startAt: at, minutes: 120 });
  const did = evOf(out, 'decision.opened')[0].id;
  check('the outing is committed (owner)', S().decisions.get(did)?.status === 'committed');
  const rev = await applyOk({ kind: 'decision.pick', decisionId: did, optionId: 'stay' });
  check('an owner reversal → stay, by owner', S().decisions.get(did)?.committed?.optionId === 'stay' && S().decisions.get(did)?.committed?.by === 'owner');
  check('…reverses_commit info', (rev.p.continuity?.warnings ?? []).some(w => w.code === 'reverses_commit'));
  eq('the same option again → nothing', await code(director.preview({ kind: 'decision.pick', decisionId: did, optionId: 'stay' }, { relax: true })), 'refused:nothing');
  await applyOk({ kind: 'decision.pick', decisionId: did, optionId: 'go' });
  const well = await applyOk({ kind: 'outcome', decisionId: did, outcome: 'well' });
  check('outcome.set folded as set', S().story.outcomes?.[did]?.status === 'set' && evOf(well, 'outcome.set').length === 1);
  eq('a second outcome → outcome_set', await code(director.preview({ kind: 'outcome', decisionId: did, outcome: 'badly' }, { relax: true })), 'refused:outcome_set');
  // A chat-shaped decision is never a target.
  // 2026-11-02: a lean a chat nudged (an origin only) is his own plan; made in a chat (opened, adopted, invited, a reply) is not.
  const fake = { id: 1, status: 'open', origins: [{ kind: 'dm', jid: 'x@s.whatsapp.net' }] };
  check('isChatDecision: made in a chat, not a nudged lean', !isChatDecision(fake) && isChatDecision({ ...fake, chatOpened: true }) && isChatDecision({ invite: true })
    && isChatDecision({ committed: { by: 'reply' } }) && isChatDecision({ adopted: true }) && !isChatDecision({ status: 'open' }));
}

section('mood and health later (§P1.5)');
{
  const m = await applyOk({ kind: 'mood', preset: 'exhausted', wakeDay: 1 });
  const id = evOf(m, 'vitals.planned')[0].id;
  check('vitals.planned {wakeDate} pending', !!S().story.pending?.[id]?.due?.wakeDate);
  eq('a mood "now" → use_quick', await code(director.preview({ kind: 'mood', preset: 'calm', when: { inMinutes: 0 } }, { relax: true })), 'refused:use_quick');
  const h = await applyOk({ kind: 'health', change: 'sick', days: 2, when: { inMinutes: 1200 } });
  const hid = evOf(h, 'sick.planned')[0].id;
  check('sick.planned pending', S().story.pending?.[hid]?.type === 'sick.planned');
  life.revertEvent(hid, { reason: 'test' });
  check('…revertible while pending', !S().story.pending?.[hid]);
  eq('well while not sick → nothing', await code(director.preview({ kind: 'health', change: 'well' }, { relax: true })), 'refused:nothing');
}

section('cast depart / return (§P1.6)');
{
  const member = [...S().cast.values()].find(c => c.relation === 'friend' || c.relation === 'coworker');
  const dep = await applyOk({ kind: 'cast.depart', castId: member.id, how: 'moved_away' });
  check('gone from the active cast', !S().cast.has(member.id) && S().story.departed?.[member.id]?.how === 'moved_away');
  eq('their name still resolves', castNameOf(S(), member.id), member.name);
  eq('departing again → not_found cast', await code(director.preview({ kind: 'cast.depart', castId: member.id, how: 'moved_away' }, { relax: true })), 'not_found:cast');
  // A new member with the same name slug never takes the departed id.
  const nc = await applyOk({ kind: 'scene', shape: 'new_cast', name: `${member.name.split(' ')[0]}x Qz`, relation: 'friend' });
  check('a new member gets a fresh id', evOf(nc, 'cast.created')[0].payload.id !== member.id);
  const ret = await applyOk({ kind: 'cast.return', castId: member.id });
  check('return restores them', S().cast.has(member.id) && !S().story.departed?.[member.id] && evOf(ret, 'cast.returned').length === 1);
  eq('return again → nothing', await code(director.preview({ kind: 'cast.return', castId: member.id }, { relax: true })), 'refused:nothing');
  void dep;
}

section('REVERT THIS CHANGE (owner decision 6)');
{
  // A departure that ends a storyline: one revert brings both back.
  const ids = [...S().cast.values()].filter(c => c.relation === 'friend' || c.relation === 'coworker').map(c => c.id);
  const arc = await applyOk({ kind: 'scene', shape: 'arc.start', category: 'cast', arcKind: 'friendship', castIds: [ids[0]] });
  const arcId = evOf(arc, 'arc.started')[0].id;
  const dep = await applyOk({ kind: 'cast.depart', castId: ids[0], how: 'written_out' });
  check('the departure ended the storyline', S().story.arcs[arcId].status === 'ended');
  const p = life.revertChangePreview(dep.r.actionEventId);
  check('preview lists the departure and the arc end', p.targets.some(t => t.type === 'cast.departed') && p.targets.some(t => t.type === 'arc.ended') && !p.refusals.length);
  let stale = null;
  try { life.revertChange(dep.r.actionEventId, { fingerprint: 'nope' }); } catch (e) { stale = e.code; }
  eq('a wrong fingerprint → stale', stale, 'stale');
  const res = life.revertChange(dep.r.actionEventId, { fingerprint: p.fingerprint });
  check('one revert per part', res.reverted.length === p.targets.length);
  check('…the member is back and the storyline active again', S().cast.has(ids[0]) && S().story.arcs[arcId].status === 'active');
  const again = life.revertChangePreview(dep.r.actionEventId);
  check('a second preview: nothing left', again.targets.length === 0);
  // An applied career change refuses the whole change.
  const job = await applyOk({ kind: 'career', change: 'promote', salary: 70000 });
  const pj = life.revertChangePreview(job.r.actionEventId);
  check('an applied career change → refused already_happened', pj.refusals.some(r => r.reason === 'already_happened'));
  let refused = null;
  try { life.revertChange(job.r.actionEventId, { fingerprint: pj.fingerprint }); } catch (e) { refused = e.code; }
  eq('…revertChange refuses', refused, 'refused');
  // An owner pick reverts as a change while nothing came of it yet.
  const placeId = [...S().places.values()].find(x => x.kind !== 'home' && x.kind !== 'office')?.id;
  const out = await applyOk({ kind: 'scene', shape: 'outing', placeId, castIds: [], startAt: clock.now() + 8 * HOUR, minutes: 90 });
  const did = evOf(out, 'decision.opened')[0].id;
  const po = life.revertChangePreview(out.r.actionEventId);
  check('an outing scene: the decision reverts, its commit rides along', po.targets.some(t => t.type === 'decision.opened') && po.riding.some(t => t.type === 'decision.committed') && !po.refusals.length);
  life.revertChange(out.r.actionEventId, { fingerprint: po.fingerprint });
  check('…the decision is gone', !S().decisions.has(did));
}

section('REVERT THIS CHANGE: a tray adoption goes back to the tray; an approved proposal is undone');
{
  const dm = '15550003333@s.whatsapp.net';
  const now = clock.now();
  const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, ?, 'see you at the cafe tomorrow', 'commitment', 0.9, 'flagged', ?)`).run(dm, dm, `MSG-revert-${now}`, now).lastInsertRowid);
  const flagged = appendEvent({ type: 'claim.flagged', at: now, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId } });
  const { id: reviewId } = store.createReview({ claimId, claimEventId: flagged.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: now, status: 'tray' });
  const placeId = [...S().places.values()].find(x => x.kind !== 'home' && x.kind !== 'office')?.id;
  // A slot the calendar fit accepts (the earlier sections left plans behind).
  for (const h of [30, 34, 54, 58, 78, 102, 126]) {
    store.updateReview(reviewId, {
      reason: 'review_mode', extraction: { type: 'plan', kind: 'coffee', summary: 'coffee', people: [] },
      resolution: { placeId, castIds: [], subjectJid: dm, span: { start: now + h * HOUR, end: now + (h + 1) * HOUR } },
    });
    if (!director.plan({ kind: 'tray.adopt', reviewId }, S(), { now }).refusals.length) break;
  }
  const ad = await applyOk({ kind: 'tray.adopt', reviewId });
  eq('adopted', store.getReview(reviewId).status, 'adopted');
  const claimRow = () => { const c = getDb().prepare('SELECT status, reviewed_at, reviewed_by FROM life_claims WHERE id = ?').get(claimId); return [c.status, c.reviewed_at, c.reviewed_by]; };
  eq('…its life_claims row too', claimRow()[0], 'adopted');
  const p = life.revertChangePreview(ad.r.actionEventId);
  check('the preview lists the adoption', p.targets.some(t => t.type === 'claim.adopted') && !p.refusals.length);
  life.revertChange(ad.r.actionEventId, { fingerprint: p.fingerprint });
  const rv = store.getReview(reviewId);
  eq('the review is back on the tray (returned, like a rewind)', rv.status, 'returned');
  eq('…and its life_claims row is flagged again, as before the adoption', claimRow(), ['flagged', null, null]);
  check('…it can be adopted again', await code(director.preview({ kind: 'tray.adopt', reviewId })) === null);
  // A single revert of the claim.adopted (Timeline REVERT) does the same.
  const ad2 = await applyOk({ kind: 'tray.adopt', reviewId });
  eq('re-adopted (review + claim row)', [store.getReview(reviewId).status, claimRow()[0]], ['adopted', 'adopted']);
  life.revertEvent(evOf(ad2, 'claim.adopted')[0].id, { reason: 'test' });
  eq('a single revert: review returned, claim row flagged again', [store.getReview(reviewId).status, ...claimRow()], ['returned', 'flagged', null, null]);

  // An approved weekly proposal: its parts are 'mind' events under the owner action.
  const beat = director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:flatmate', beatKind: 'hobby', text: 'took up chess' }, S(), { now: clock.now() })
    .events.find(e => e.type === 'cast.beat');
  director.__setDepsForTest({ proposalDescriptors: () => ({ events: [{ ref: 'x1', type: 'cast.beat', payload: beat.payload }] }) });
  const pid = store.createProposal({ runId: 1, weekKey: '2026-W44', category: 'cast', kind: 'beat', payload: { castId: 'cast:flatmate' }, createdAt: clock.now() });
  const ap = await applyOk({ kind: 'proposal.approve', proposalId: pid });
  eq('proposal applied, its beat a mind event', [store.getProposal(pid).status, evOf(ap, 'cast.beat')[0]?.actor], ['applied', 'mind']);
  const pp = life.revertChangePreview(ap.r.actionEventId);
  check('the preview lists the beat', pp.targets.some(t => t.type === 'cast.beat') && !pp.already);
  life.revertChange(ap.r.actionEventId, { fingerprint: pp.fingerprint });
  check('the beat is undone', isExcludedId(S(), evOf(ap, 'cast.beat')[0].id));
  eq('…and the proposal is closed (rejected: reverted)', [store.getProposal(pid).status, store.getProposal(pid).reason], ['rejected', 'reverted']);
  director.__setDepsForTest({ proposalDescriptors: null });
}

section('route shapes and the prompt side (§P1.8, §P1.9)');
{
  eq('outcome enum', actionProblem({ kind: 'outcome', decisionId: 1, outcome: 'great' }), 'bad_outcome');
  eq('career enum', actionProblem({ kind: 'career', change: 'retire' }), 'bad_change');
  eq('cast.depart id', actionProblem({ kind: 'cast.depart', castId: 'x', how: 'moved_away' }), 'bad_castId');
  eq('home needs near or area', actionProblem({ kind: 'home' }), 'bad_home');
  eq('a good pick passes', actionProblem({ kind: 'decision.pick', decisionId: 3, optionId: 'go' }), null);
  check('god kinds are draftable', ['career', 'money', 'outcome', 'cast.depart', 'mood'].every(k => director.PROMPT_ACTION_KINDS.includes(k)));
  eq('…but never batchable (god_change)', promptMod.batchableOf({ kind: 'money', mode: 'income', amount: 5 }).reviewReason, 'god_change');
  eq('a draft whose plan warns → continuity', promptMod.batchableOf({ kind: 'weather' }, { continuity: { warnings: [{ code: 'x', severity: 'warn' }] } }).reviewReason, 'continuity');
  check('the charter keeps heavy / rewind out and lists real people as can\'t do',
    /hard life events/.test(promptMod.PROMPT_CHARTER) && /rewinding or rewriting the past/.test(promptMod.PROMPT_CHARTER)
    && !/scheduling a mood for later, money, jobs/.test(promptMod.PROMPT_CHARTER));
  const { model, check: cat } = promptMod.buildCatalogue(S(), world, clock.now(), world.timezone);
  check('the catalogue has decisions / me / departed / pending', Array.isArray(model.decisions) && !!model.me && Array.isArray(model.departed) && Array.isArray(model.pending));
  check('…never an employer name', !JSON.stringify(model.me).includes(S().story.career.employerName ?? '\u0000'));
  const raw = JSON.stringify({ actions: [
    { action: { kind: 'career', change: 'job', title: 'Designer', employerName: 'Some Real Co' } },
    { action: { kind: 'money', mode: 'income', amount: 100 } },
  ] });
  const v = validatePromptOutput(raw, cat, promptMod.VOCAB);
  check('a drafted employer name is dropped (bad_employerName)', v.dropped.some(d => d.reason === 'bad_employerName'));
  check('…a money draft passes', v.drafts.some(d => d.action.kind === 'money'));
}

await stopLife();
report();
