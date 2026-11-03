// Life · Director — TELL THE STORY (spec 011, made easy to use by spec 017),
// mounted by pages/life-director.js in its TELL THE STORY panel.
//
// Three steps on one panel: 1 YOUR WISH (the textarea; SHOW ME THE PLAN makes the
// one model call, POST /api/director/prompt), 2 CHECK THE PLAN (the code-built
// plan line, one card per draft in plain words: READY / NEEDS YOU / WON'T WORK,
// the venue pick or MOVE TO EARLIEST right on the card, LEAVE OUT, and what the
// answer left out), 3 MAKE IT HAPPEN (every kept draft previewed as ONE bundle
// with `source:'prompt'`, so nothing plans with the owner's relaxed rules: his
// day before → after, the continuity warnings as choices, the story read and its
// suggestions, one apply with the bundle's fingerprint), then DONE (what changed,
// UNDO ALL OF THIS = the grouped revert of the bundle's parts).
//
// One MAKE IT HAPPEN replaces APPLY ALL because step 3 is the review: every
// free-text field is shown verbatim (step 2 cards, repeated in step 3), a HIGH
// warning needs its tick, a draft that can loosen a control needs its own tick,
// and a god change is labelled. A stale preview is previewed again and asked
// again — never applied silently. Bookmarks can't ride in a bundle: they apply
// right after it succeeded, never when it failed. More than BUNDLE_MAX main
// drafts → two steps, the second previewed after the first is applied.
//
// TECHNICAL (a per-browser switch, off by default) shows the engine's words under
// each card and in step 3 (kind, status, review reason, events, codes, the
// call), plus APPLY ONE BY ONE: the old per-draft preview window.
//
// Strings from a model, the world or the wish reach the DOM through html`` only.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, $ } from '../core/dom.js';
import { fmtHm, fmtDay } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { scheduleDraftVenues } from '../components/schedule-panel.js';
import { upper } from './life-cast.js';
import {
  continuityOf, keepInstead, movedTo, refusalOf, autoStoryRead, suggestionsOf,
} from './life-director.js';

export const BUNDLE_MAX = 5;   // the Director's bundle cap (story/director.js BUNDLE_MAX)
const TECH_KEY = 'ld.story.tech';
const SEV_ORDER = { high: 0, warn: 1, info: 2 };

// Why the page threw a draft away, in plain words (the validator's, the planner's
// and the route's codes; an unknown code reads as its words).
export const DROP_REASONS = Object.freeze({
  too_many: 'more than six actions — the extra ones were left out',
  not_allowed: 'a kind of change words may not make (use its panel)',
  bad_action: 'not a change the Director knows',
  bad_key: 'carried a field that is never allowed',
  unknown_cast: 'named someone who is not in his life',
  unknown_place: 'named a place that is not in his world',
  unknown_ref: 'pointed at an arc, goal, window or plan that does not exist',
  bad_time: 'a time or day out of range',
  identifier_in_text: 'its text had a link, an e-mail or a number in it',
  bad_field: 'a field was missing or out of range',
  real_person: 'how a plan with a real person turns out is not something to make up: only a pick or a cancel',
  route_shape: 'the dashboard refused its shape',
  bad_employerName: 'it named an employer (the owner fills that in)',
  bad_venue: 'the venue it named failed the checks (a person\'s name, a number, a blocked word)',
  unrequested: 'a bookmark you did not ask for (write "bookmark this" or "remember this moment" to get one)',
  in_past: 'it would start in the past',
  too_far: 'too far ahead',
  full: 'his calendar or world is full there',
  overlap: 'it overlaps a schedule change already set',
  unfit: 'it does not fit into his day',
  geo_off: 'the place lookup is off',
  no_place: 'there is no place for it',
  private_place: 'it would use his home or office',
  sick: 'he is sick',
  asleep_now: 'he is asleep now',
  during_travel: 'he is on the way somewhere then',
  real_business: 'it named a real business as his job or office',
  real_person_name: 'it used a real person\'s name',
  name_collision: 'that name is already someone in his life',
  not_found: 'something it pointed at no longer exists',
  refused: 'the Director refused it',
  invalid: 'the Director found it invalid',
});
export const dropText = (r) => DROP_REASONS[r] || String(r || 'dropped').replace(/_/g, ' ');

// Why a draft isn't in APPLY ONE BY ONE's batch (technical view only now).
export const REVIEW_REASONS = Object.freeze({ free_text: 'HAS FREE TEXT', target_resolved: 'PICKS ITS TARGET WHEN PLANNED', loosens_control: 'LOOSENS A CONTROL',
  god_change: 'REWRITES HIS FUTURE', continuity: 'HAS CONTINUITY WARNINGS',   // 015
  too_soon: 'STARTS TOO SOON', no_route: 'NO WAY TO GET THERE', depends_on_main: 'GOES WITH ANOTHER DRAFT' });

// Draft kinds the owner can loosen a control with, and the god kinds (labelled).
const LOOSENS = new Set(['unpin', 'resume', 'fate', 'slider']);
const GOD_KINDS = new Set(['decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return']);
const loosens = (d) => d?.reviewReason === 'loosens_control' || (LOOSENS.has(d?.action?.kind) && !(d.action.kind === 'fate' && d.action.mode === 'frozen'));
const isGod = (d) => d?.reviewReason === 'god_change' || GOD_KINDS.has(d?.action?.kind);
const isBookmark = (d) => d?.action?.kind === 'bookmark';

// Plain words for a projected block's kind (an unknown kind reads as its words).
const BLOCK_WORDS = { commute: 'on the way', free: 'free time', sleep: 'asleep', work: 'work', work_home: 'work from home', meeting: 'a meeting',
  breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', 'eat-out': 'eating out', hangout: 'out with people', outing: 'out', visit: 'a visit',
  gym: 'the gym', errand: 'an errand', sick: 'resting, sick', break: 'a break' };
const blockWord = (k) => BLOCK_WORDS[k] || String(k || '').replace(/[._-]/g, ' ');

// Ideas: a click fills the box (nothing is sent).
export const IDEAS = [
  ['Dinner with a friend', 'he has dinner with a friend tomorrow evening'],
  ['A day off', 'he takes Friday off and sleeps in'],
  ['Meets someone new', 'he meets someone new at a café this weekend'],
  ['Rain all evening', 'it rains all evening today'],
];

/**
 * A side lock: a draft that goes with the wish's main drafts (`dependsOn`, server
 * holdSideDrafts) → null when every main is kept here, else { dropped } (a main
 * was dropped by the server or left out here: it never happens) | { waitFor:
 * [card numbers] } (a main not applied yet — the one-by-one path only).
 */
export function sideLock(d, cards) {
  const deps = Array.isArray(d?.dependsOn) ? d.dependsOn : [];
  if (!deps.length) return null;
  const list = Array.isArray(cards) ? cards : [];
  const at = (ix) => list.findIndex((c) => c?.draft?.index === ix);
  if (deps.some((ix) => at(ix) < 0 || (list[at(ix)].removed && !list[at(ix)].applied))) return { dropped: true };
  const waitFor = deps.filter((ix) => !list[at(ix)].applied).map((ix) => at(ix) + 1);
  return waitFor.length ? { waitFor } : null;
}

/**
 * A card's state on step 2 → { key: ready|needs|wont|checking|gone, text?, fix? }.
 * needs = the owner has to choose something on the card (a venue, a new start);
 * wont = the Director refuses it as it is (LEAVE OUT, or fix it); gone = it goes
 * with a draft that was dropped or left out.
 */
export function cardState(c, cards) {
  const d = c.draft;
  if (sideLock(d, cards)?.dropped) return { key: 'gone', text: 'it goes with a change that was left out, so it can\'t happen on its own' };
  if (d.status === 'needs_pick' || d.status === 'needs_venue') return { key: 'needs', text: 'pick the real place for it' };
  if (d.status === 'too_soon') return Number.isSafeInteger(d.earliestAt)
    ? { key: 'needs', text: `he can't get there in time — the earliest he could arrive is ${fmtHm(d.earliestAt)}`, fix: 'early' }
    : { key: 'wont', text: 'he can\'t get there in time' };
  if (d.status === 'no_route') return { key: 'wont', text: 'he has no way to get there from where he is' };
  if (c.previewing || (!c.preview && !c.previewError)) return { key: 'checking' };
  if (c.previewError) return { key: c.previewFix ? 'needs' : 'wont', text: c.previewError, fix: c.previewFix ? 'move' : null };
  const refusals = Array.isArray(c.preview?.refusals) ? c.preview.refusals : [];
  if (refusals.length) return { key: 'wont', text: refusals.map((r) => dropText(r.reason)).join('; ') };
  if (!(c.preview?.events ?? []).some((e) => e.type !== 'director.action')) return { key: 'wont', text: 'it changes nothing in his world as things are now' };
  return { key: 'ready' };
}

/**
 * The kept drafts in the order they apply → { bundles: [[card index…] ≤ BUNDLE_MAX],
 * after: [card index…] } — mains (not bookmarks) in draft order, chunked; side
 * bookmarks after every bundle. Cards not ready never go.
 */
export function bundlesOf(cards) {
  const kept = cards.map((c, i) => [c, i]).filter(([c]) => !c.removed && !c.applied && cardState(c, cards).key === 'ready');
  // Main drafts first, then the ones that go with them (a side draft never lands before its main).
  const mains = kept.filter(([c]) => !isBookmark(c.draft)).sort(([a, x], [b, y]) => (a.draft.side === true) - (b.draft.side === true) || x - y).map(([, i]) => i);
  const after = kept.filter(([c]) => isBookmark(c.draft)).map(([, i]) => i);
  const bundles = [];
  for (let k = 0; k < mains.length; k += BUNDLE_MAX) bundles.push(mains.slice(k, k + BUNDLE_MAX));
  return { bundles, after };
}

/** The bundle action for card indexes (parts tagged `source:'prompt'`). */
export function bundleAction(cards, idx, extra = []) {
  return { kind: 'bundle', actions: [...idx.map((i) => ({ ...cards[i].draft.action, source: 'prompt' })), ...extra].slice(0, BUNDLE_MAX) };
}

/**
 * The plan line: the server's code-built one while every draft is kept, else the
 * kept drafts' code-built phrases (their summaries when a phrase is missing) —
 * never model text.
 */
export function planLineOf(res, cards) {
  if (typeof res?.planLine === 'string' && res.planLine && !cards.some((c) => c.removed)) return res.planLine;
  const list = cards.filter((c) => !c.removed).map((c) => c.draft.phrase || c.draft.summary).filter(Boolean);
  return list.length ? `${list.join('; ')}.`.replace(/\.\.$/, '.') : '';
}

const readTech = () => { try { return localStorage.getItem(TECH_KEY) === '1'; } catch { return false; } };
const writeTech = (on) => { try { localStorage.setItem(TECH_KEY, on ? '1' : '0'); } catch { /* per-browser convenience only */ } };
const dis = (off) => (off ? 'disabled' : '');

// ── views ──────────────────────────────────────────────────────────────────

export function storyShell() {
  return html`<div class="panel story-prompt" data-panel="prompt">
  <div class="panel-head"><span>TELL THE STORY<button type="button" class="guide-q" data-guide="prompt" aria-label="Guide: tell the story">?</button></span>
    <label class="mono mute ld-tell-tech"><input type="checkbox" id="ldTellTech"> TECHNICAL</label></div>
  <div class="panel-body">
    <ol class="ld-tell-steps" aria-label="Steps" data-slot="ld-tell-steps"></ol>
    <div data-slot="ld-tell-body"></div>
  </div>
</div>`;
}

function stepsView(step) {
  const order = ['wish', 'plan', 'check'];
  const at = step === 'done' ? 3 : order.indexOf(step);
  const names = ['Your wish', 'Check the plan', 'Make it happen'];
  return names.map((n, i) => html`<li class="${i === at ? 'is-on' : i < at ? 'is-done' : ''}" ${i === at ? 'aria-current="step"' : ''}>
    <span class="mono">STEP ${i + 1}${i < at ? ' ✓' : ''}</span><span>${n}</span></li>`);
}

export function wishView(s, ro, meta) {
  return html`<div class="ld-tell-wish">
    <h3 class="ld-tell-h">What should happen in his life?</h3>
    <p class="ld-tell-lead">Write it the way you'd tell a friend. You'll see a plan first — nothing changes until you press <b>MAKE IT HAPPEN</b>.</p>
    <label class="mono mute" for="ldWish">YOUR WISH</label>
    <textarea id="ldWish" class="story-prompt-wish" maxlength="400" rows="3" placeholder="e.g. he catches up with a friend over dinner next week" ${dis(ro)}>${s.wish}</textarea>
    <div class="ld-tell-row mute"><span>People in his life by name are fine; real people's names aren't.</span><span class="mono" data-slot="ld-tell-count">${s.wish.length}/400</span></div>
    <div class="mono mute">OR START FROM AN IDEA</div>
    <div class="story-buttons">${IDEAS.map(([label], i) => html`<button type="button" class="ld-tell-idea" data-idea="${i}" ${dis(ro)}>${label}</button>`)}</div>
    <div class="story-buttons"><button type="button" class="primary ld-tell-big" id="ldSuggest" ${dis(ro || s.running)}>${s.running ? 'THINKING…' : 'SHOW ME THE PLAN'}</button></div>
    <div class="mono mute" data-slot="ld-prompt-meta">${meta}</div>
    ${s.error ? html`<div class="red mono">NO PLAN · ${s.error}</div>` : ''}
    <ol class="ld-tell-next">
      <li>The mind turns your wish into a short plan: who, where, when, and anything new it needs (a new person, a new place).</li>
      <li>You check it. If something needs your choice — which café, a later start — it asks you right there.</li>
      <li>You see how his day changes, then one button makes it real. You can undo it all afterwards.</li>
    </ol>
    ${s.res ? html`<div class="story-buttons"><button type="button" class="ld-tell-reopen">REOPEN THE LAST PLAN ›</button></div>` : ''}
  </div>`;
}

const STATE_CHIP = { ready: ['ok', 'READY'], needs: ['warn', 'NEEDS YOU'], wont: ['bad', 'WON\'T WORK'], checking: ['', 'CHECKING…'], gone: ['', 'WON\'T HAPPEN'] };

function techDraft(c, cards) {
  const d = c.draft;
  const events = (Array.isArray(c.preview?.events) ? c.preview.events : []).filter((e) => e.type !== 'director.action');
  const cont = continuityOf(c.preview);
  const lock = sideLock(d, cards);
  return html`<dl class="story-dl ld-tell-techlist mono">
    <dt>kind</dt><dd>${d.action?.kind}${d.side ? ' · side draft' : ''}</dd>
    ${d.status ? html`<dt>status</dt><dd>${d.status}</dd>` : ''}
    <dt>events</dt><dd>${events.length ? events.map((e) => html`<div>${e.type} · ${e.actor}</div>`) : '—'}</dd>
    ${Array.isArray(d.dependsOn) && d.dependsOn.length ? html`<dt>depends on</dt><dd>${d.dependsOn.map((n) => `#${n + 1}`).join(', ')}${lock?.waitFor ? ` · waits for ${lock.waitFor.map((n) => `#${n}`).join(', ')}` : ''}</dd>` : ''}
    <dt>one by one</dt><dd>${d.batchable ? 'batchable' : `review · ${d.reviewReason || '—'} (${REVIEW_REASONS[d.reviewReason] || 'REVIEW'})`}</dd>
    ${cont.length ? html`<dt>continuity</dt><dd>${cont.map((w) => html`<div>${upper(w.severity)} ${w.code}</div>`)}</dd>` : ''}
    ${(c.preview?.refusals ?? []).length ? html`<dt>refusals</dt><dd>${c.preview.refusals.map((r) => r.reason).join(', ')}</dd>` : ''}
    ${(d.warnings ?? []).length ? html`<dt>warnings</dt><dd>${d.warnings.join(' · ')}</dd>` : ''}
  </dl>`;
}

function planCard(c, i, cards, ro, places, tech) {
  const d = c.draft;
  const state = cardState(c, cards);
  const [chip, label] = STATE_CHIP[state.key];
  const texts = Array.isArray(d.texts) ? d.texts : [];
  const dep = Array.isArray(d.dependsOn) && d.dependsOn.length
    ? d.dependsOn.map((ix) => cards.findIndex((o) => o.draft.index === ix) + 1).filter((n) => n > 0) : [];
  return html`<div class="story-prompt-card ld-tell-card is-${state.key} ${dep.length ? 'is-side' : ''}" data-card="${i}">
    <div class="ld-tell-cardhead"><span class="mono mute">${i + 1}${dep.length ? ` · GOES WITH ${dep.join(', ')}` : ''}${isGod(d) ? ' · REWRITES HIS FUTURE' : ''}</span>
      <span class="chip ${chip}">${label}</span></div>
    <div class="ld-tell-title">${d.summary || upper(d.action?.kind)}</div>
    ${d.why ? html`<div class="story-prompt-why">${d.why}</div>` : ''}
    ${texts.length ? html`<dl class="story-dl story-prompt-texts">${texts.map((t) => html`<dt>${upper(t.field)}</dt><dd>${t.value}</dd>`)}</dl>` : ''}
    ${(d.warnings ?? []).length && !tech ? html`<div>${d.warnings.map((w) => html`<div class="amber">⚠ ${w}</div>`)}</div>` : ''}
    ${loosens(d) ? html`<div class="amber">This loosens one of your controls — you'll be asked to confirm it before it happens.</div>` : ''}
    ${dep.length ? html`<div class="mute">Only happens together with ${dep.length === 1 ? `change ${dep[0]}` : `changes ${dep.join(', ')}`}. Leave ${dep.length === 1 ? 'that' : 'those'} out and this goes too.</div>` : ''}
    ${state.text ? html`<div class="${state.key === 'needs' ? 'amber' : 'red'}">${state.key === 'needs' ? 'Needs you: ' : state.key === 'gone' ? '' : 'Won\'t work: '}${state.text}</div>` : ''}
    ${scheduleDraftVenues(d, i, ro, places)}
    <div class="story-buttons">
      ${state.fix === 'early' ? html`<button type="button" class="primary ld-p-early" data-card="${i}" ${dis(ro)}>MOVE TO ${fmtHm(d.earliestAt)}</button>` : ''}
      ${state.fix === 'move' ? html`<button type="button" class="primary ld-p-move" data-card="${i}" ${dis(ro)}>MOVE TO ${fmtHm(c.previewFixAt)}</button>` : ''}
      ${c.editable ? html`<button type="button" class="ld-p-edit" data-card="${i}" ${dis(ro)}>EDIT</button>` : ''}
      <button type="button" class="ld-p-drop" data-card="${i}" ${dis(ro)}>LEAVE OUT</button>
      ${tech ? html`<button type="button" class="ld-p-open" data-card="${i}" ${dis(ro || !!d.status || state.key === 'gone')}>APPLY THIS ONE BY ITSELF</button>` : ''}
    </div>
    ${tech ? techDraft(c, cards) : ''}
  </div>`;
}

export function planView(s, ro, places) {
  const cards = s.cards;
  const shown = cards.map((c, i) => [c, i]).filter(([c]) => !c.removed && !c.applied);
  const states = shown.map(([c]) => cardState(c, cards).key);
  const count = (k) => states.filter((x) => x === k).length;
  const left = cards.map((c, i) => [c, i]).filter(([c]) => c.removed);
  const dropped = Array.isArray(s.res?.dropped) ? s.res.dropped : [];
  const cantDo = Array.isArray(s.res?.cantDo) ? s.res.cantDo : [];
  const ready = count('ready');
  const blocked = count('needs') + count('checking') + count('wont');
  const line = planLineOf(s.res, cards);
  return html`<div class="ld-tell-plan">
    <div class="ld-tell-row"><span class="mute ld-tell-wishecho">“${s.lastWish}”</span><button type="button" class="ld-tell-back" data-to="wish">EDIT WISH</button></div>
    ${s.res?.fellBack ? html`<div class="story-note amber mono">ANSWERED BY THE FALLBACK MODEL</div>` : ''}
    ${line ? html`<div class="ld-tell-line"><div class="mono mute">THE PLAN</div><p>${line}</p></div>` : ''}
    <div class="ld-tell-row"><span class="mono mute">${shown.length} CHANGE${shown.length === 1 ? '' : 'S'} TO HIS WORLD</span>
      <span>${ready ? html`<span class="ok-ink">${ready} ready</span>` : ''}${count('needs') ? html` · <span class="amber">${count('needs')} need${count('needs') === 1 ? 's' : ''} you</span>` : ''}${count('wont') ? html` · <span class="red">${count('wont')} won't work</span>` : ''}${count('checking') ? html` · <span class="mute">checking ${count('checking')}…</span>` : ''}</span></div>
    ${shown.length ? shown.map(([c, i]) => planCard(c, i, cards, ro, places, s.tech)) : html`<div class="empty">NO CHANGES IN THIS PLAN</div>`}
    ${left.length || dropped.length || cantDo.length ? html`<div class="story-sub mono">NOT IN THE PLAN</div><ul class="story-list ld-tell-out">
      ${left.map(([c, i]) => html`<li>${c.draft.summary || upper(c.draft.action?.kind)} <span class="mute">— you left it out</span> <button type="button" class="ld-tell-putback" data-card="${i}" ${dis(ro)}>PUT BACK</button></li>`)}
      ${dropped.map((x) => html`<li>${x.kind ? `${upper(x.kind)} ` : ''}<span class="mute">— left out: ${dropText(x.reason)}</span>${s.tech ? html` <span class="chip" title="reason code">${x.reason}</span>` : ''}</li>`)}
      ${cantDo.map((x) => html`<li>${x} <span class="mute">— can't do this yet</span></li>`)}
    </ul>` : ''}
    ${s.tech ? html`<div class="mono mute ld-tell-call">THE CALL · director.prompt · ${s.res?.model || '—'}${s.res?.fellBack ? ' · fell back' : ''} · today ${s.res?.usage?.today ?? '—'}/${s.res?.usage?.cap ?? '—'}</div>` : ''}
    <div class="ld-tell-bar">
      <span class="${blocked ? 'amber' : 'mute'}">${!ready ? 'Nothing is ready yet.' : blocked ? `${blocked} change${blocked === 1 ? '' : 's'} not ready — choose, fix or leave ${blocked === 1 ? 'it' : 'them'} out.` : 'Still nothing is changed — that\'s the next step.'}</span>
      <button type="button" class="primary ld-tell-big ld-tell-tocheck" ${dis(ro || !ready || blocked > 0)}>CHECK HOW HIS DAY CHANGES ›</button>
    </div>
  </div>`;
}

function aheadPlain(pr) {
  if (!pr) return html`<div class="mono mute">NO DAY PREVIEW FOR THIS PLAN</div>`;
  if (pr.skipped || pr.timedOut) return html`<div class="mono mute">His day couldn't be simulated this time (${pr.skipped || 'took too long'}). The checks below still ran.</div>`;
  const rows = Array.isArray(pr.rows) ? pr.rows : [];
  const changed = rows.filter((r) => r.change !== 'same');
  if (!changed.length) return html`<div class="mute">His day looks the same.</div>`;
  const days = new Map();
  for (const r of rows) {
    const d = fmtDay(r.at);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  const mark = { added: '+', removed: '−', moved: '→', same: '' };
  return html`${[...days.entries()].map(([day, list]) => html`<div class="mono mute ld-tell-day">${day === pr.today ? 'TODAY' : day}</div>
    <ul class="ld-tell-ahead">${list.map((r) => html`<li class="is-${r.change}"><span class="mono">${mark[r.change] ?? ''} ${fmtHm(r.at)}</span>
      <span>${r.change === 'removed' ? html`<s>${blockWord(r.kind)}</s>` : blockWord(r.kind)}${r.place ? ` · ${r.place}` : ''}${(r.cast ?? []).length ? ` · with ${r.cast.join(', ')}` : ''}${r.change === 'moved' && r.wasAt ? html` <span class="mute">(was ${fmtHm(r.wasAt)})</span>` : ''}${r.change === 'same' ? html` <span class="mute">· as before</span>` : ''}</span></li>`)}</ul>`)}
    <div class="ld-tell-nums mono"><span>ENERGY AT BEDTIME ${pr.energyAtSleep?.before ?? '—'} → ${pr.energyAtSleep?.after ?? '—'}</span><span>MONEY ${pr.money?.before ?? '—'} → ${pr.money?.after ?? '—'}</span></div>
    ${(pr.decisions ?? []).filter((d) => d.before !== d.after).map((d) => html`<div class="mute">${d.label}: ${d.before ?? '—'} → ${d.after ?? '—'}</div>`)}`;
}

// The ticks MAKE IT HAPPEN waits for: every HIGH code, and every draft that loosens a control.
export function ticksNeeded(p, cards, idx) {
  const high = [...new Set(continuityOf(p).filter((w) => w.severity === 'high').map((w) => w.code))].map((code) => `high:${code}`);
  const loose = idx.filter((i) => loosens(cards[i]?.draft)).map((i) => `loosens:${i}`);
  return [...high, ...loose];
}

export function checkView(s, ro) {
  const k = s.check;
  const cards = s.cards;
  const head = html`<div class="ld-tell-row"><h3 class="ld-tell-h">His day, with this plan</h3>
    ${k.total > 1 ? html`<span class="mono amber">PART ${k.part + 1} OF ${k.total}</span>` : ''}</div>
    <div class="mute">A dry run. Nothing is written yet.</div>`;
  if (k.previewing) return html`${head}<div class="loading">PREVIEWING HIS DAY…</div>`;
  if (k.error) return html`${head}<div class="red">This plan can't be checked as it is: ${k.error}</div>
    ${k.errorFix ? html`<div class="story-buttons"><button type="button" class="primary ld-tell-movepart" ${dis(ro)}>MOVE TO ${fmtHm(k.errorFixAt)}</button></div>` : ''}
    <div class="story-buttons"><button type="button" class="ld-tell-back" data-to="plan">‹ BACK TO THE PLAN</button></div>`;
  const p = k.shown();
  if (!p) return head;
  const refusals = Array.isArray(p.refusals) ? p.refusals : [];
  const warnings = continuityOf(p).sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
  const plain = Array.isArray(p.warnings) ? p.warnings : [];
  const idx = k.idx;
  const texts = idx.flatMap((i) => (cards[i].draft.texts ?? []).map((t) => ({ ...t, n: i + 1 })));
  const ticks = ticksNeeded(p, cards, idx);
  const missing = ticks.filter((t) => !k.ticks.has(t));
  const sgs = suggestionsOf(k.cont);
  const changes = (p.events ?? []).filter((e) => e.type !== 'director.action').length;
  return html`${head}
    ${refusals.length ? html`<div class="red">The Director refuses part of it: ${refusals.map((r) => `${Number.isInteger(r.part) ? `change ${idx[r.part] + 1}: ` : ''}${dropText(r.reason)}`).join('; ')}</div>` : ''}
    <div class="ld-tell-daybox">${aheadPlain(p.projection)}</div>
    ${warnings.length || plain.length || ticks.some((t) => t.startsWith('loosens:')) ? html`<div class="story-sub mono">BEFORE YOU GO AHEAD</div>` : ''}
    ${warnings.map((w) => html`<div class="ld-tell-warn is-${w.severity}">
      <span class="chip ${w.severity === 'high' ? 'bad' : w.severity === 'warn' ? 'warn' : ''}">${w.severity === 'high' ? 'IMPORTANT' : w.severity === 'warn' ? 'CHECK THIS' : 'GOOD TO KNOW'}</span>
      <span>${w.text}${w.fromChat ? html` <span class="mute">· a plan from a chat</span>` : ''}</span>
      ${Array.isArray(w.keep) && w.keep.length ? html`<button type="button" class="ld-tell-keep" data-keys="${w.keep.join(',')}" ${dis(ro)}>KEEP ${w.keep.length === 1 ? 'IT' : 'THEM'} INSTEAD</button>` : ''}
      ${w.severity === 'high' ? html`<label class="ld-tell-tick"><input type="checkbox" class="ld-tell-tickbox" data-tick="high:${w.code}" ${k.ticks.has(`high:${w.code}`) ? 'checked' : ''} ${dis(ro)}> I understand, go ahead anyway</label>` : ''}
      ${s.tech ? html`<span class="mono mute">${w.code}</span>` : ''}</div>`)}
    ${plain.map((w) => html`<div class="ld-tell-warn is-info"><span class="chip">NOTE</span><span>${w}</span></div>`)}
    ${idx.filter((i) => loosens(cards[i].draft)).map((i) => html`<div class="ld-tell-warn is-warn"><span class="chip warn">LOOSENS A CONTROL</span>
      <span>Change ${i + 1}: ${cards[i].draft.summary}</span>
      <label class="ld-tell-tick"><input type="checkbox" class="ld-tell-tickbox" data-tick="loosens:${i}" ${k.ticks.has(`loosens:${i}`) ? 'checked' : ''} ${dis(ro)}> Yes, loosen it</label></div>`)}
    ${texts.length ? html`<div class="story-sub mono">WORDS THAT GO INTO HIS WORLD</div><dl class="story-dl">${texts.map((t) => html`<dt>${t.n} · ${upper(t.field)}</dt><dd>${t.value}</dd>`)}</dl>` : ''}
    <div class="story-sub mono">THE MIND'S READ</div>
    ${k.cont.reading ? html`<div class="mono mute">READING…</div>`
      : k.cont.read?.status === 'ok' ? html`${(k.cont.read.warnings ?? []).length ? k.cont.read.warnings.map((w) => html`<div class="${w.severity === 'info' ? 'mute' : 'amber'}">${w.text}</div>`) : html`<div class="mute">Nothing to add — it fits his story.</div>`}`
      : k.cont.read ? html`<div class="mono mute">The mind's read isn't available (${k.cont.read.reason || k.cont.read.status}); the code checks above still ran.</div>`
      : html`<div class="story-buttons"><button type="button" class="ld-tell-read" ${dis(ro)}>ASK THE MIND TO READ IT</button><span class="mono mute">ONE MODEL CALL</span></div>`}
    ${sgs.length ? html`<ul class="ld-tell-ideas">${sgs.map((sg) => html`<li><span>${sg.summary || upper(sg.action?.kind)}${sg.why ? html` <span class="mute">— ${sg.why}</span>` : ''}
      ${(sg.texts ?? []).map((t) => html`<div class="mono mute">${t.field}: ${t.value}</div>`)}</span>
      <label><input type="checkbox" class="ld-tell-add" data-key="${sg.key}" ${k.cont.added.has(sg.key) ? 'checked' : ''} ${dis(ro || idx.length + k.cont.added.size >= BUNDLE_MAX && !k.cont.added.has(sg.key))}> ADD</label></li>`)}</ul>
      ${k.cont.rebundling ? html`<div class="mono mute">RE-CHECKING WITH YOUR ADDITIONS…</div>` : ''}${k.cont.bundleError ? html`<div class="red mono">WITH THE ADDITIONS: ${k.cont.bundleError}</div>` : ''}` : ''}
    ${s.tech ? html`<details class="ld-tell-techbox" open><summary class="mono">TECHNICAL</summary>
      <div class="mono mute">bundle · ${idx.length + k.cont.added.size} part${idx.length + k.cont.added.size === 1 ? '' : 's'} · source prompt · fingerprint ${String(p.fingerprint || '').slice(0, 12)}…</div>
      <ol class="story-events mono">${(p.events ?? []).map((e) => html`<li>${e.ref || ''} ${e.type} <span class="chip">${e.actor}</span>${e.causeRef ? html` <span class="mute">← ${e.causeRef}</span>` : ''}</li>`)}</ol></details>` : ''}
    <div class="ld-tell-bar">
      <span class="${missing.length ? 'amber' : 'mute'}">${missing.length ? `Tick ${missing.length === 1 ? 'the box' : `the ${missing.length} boxes`} above to go ahead.` : 'You can undo all of it afterwards.'}</span>
      <button type="button" class="primary ld-tell-big ld-tell-apply" ${dis(ro || k.applying || !changes || refusals.length > 0 || missing.length > 0 || k.cont.rebundling)}>${k.applying ? 'MAKING IT HAPPEN…' : changes ? `MAKE IT HAPPEN · ${idx.length + k.cont.added.size} CHANGE${idx.length + k.cont.added.size === 1 ? '' : 'S'}` : 'NOTHING TO APPLY'}</button>
      <button type="button" class="ld-tell-back" data-to="plan">‹ BACK TO THE PLAN</button>
    </div>`;
}

export function doneView(s, ro) {
  const d = s.done;
  return html`<div class="ld-tell-done">
    <h3 class="ld-tell-h ok-ink">It's part of his life now</h3>
    ${d.line ? html`<p class="ld-tell-lead">${d.line}</p>` : ''}
    <div class="story-sub mono">WHAT CHANGED</div>
    <ul class="story-list">${d.items.map((t) => html`<li>✓ ${t}</li>`)}${d.failed.map((t) => html`<li class="red">✗ ${t}</li>`)}</ul>
    <div class="mute">He lives it on his own from here. An outing with someone gets its HOW IT WENT on Life · Day once it ends. Every change is on PLAY GOD → CHANGES.</div>
    <div class="story-buttons">
      <button type="button" class="primary ld-tell-again">TELL ANOTHER STORY</button>
      ${d.groups.length ? html`<button type="button" class="ld-tell-undo" ${dis(ro || d.undoing || d.undone)}>${d.undone ? 'UNDONE' : d.undoing ? 'UNDOING…' : 'UNDO ALL OF THIS'}</button>` : ''}
    </div>
    ${d.groups.length && !d.undone ? html`<div class="mono mute">Undo works while nothing in it has happened yet.</div>` : ''}
    ${s.tech ? html`<div class="mono mute">applied · ${d.groups.map((g) => `director.action #${g}`).join(', ')} · ${d.eventCount} events</div>` : ''}
  </div>`;
}

// ── mount ──────────────────────────────────────────────────────────────────

/**
 * Mount on the page's TELL THE STORY panel. opts: { ro(), places(), meta() (the
 * prompt's usage line), onApplied() (reload the page), openPreview(action, opts)
 * (the page's window: APPLY ONE BY ONE), editCard(card) (loads a draft into its
 * form below; returns false when the kind has no form) , editable(draft) }.
 * Returns { prompt, renderPrompt, previewCard } for the SCHEDULE panel's venue picks.
 */
export function mountStoryPanel(ctx, root, opts) {
  const host = root.querySelector('[data-panel="prompt"]');
  const s = {
    step: 'wish', wish: '', lastWish: '', res: null, cards: [], running: false, error: null, tech: readTech(),
    check: null, done: null,
  };
  const prompt = s;   // the SCHEDULE panel's venue picks reach s.cards through it
  const ro = () => opts.ro();
  let drawnRo = null;

  function draw() {
    if (!ctx.alive()) return;
    drawnRo = ro();
    setSlot(host, 'ld-tell-steps', stepsView(s.step));
    const tick = $(host, '#ldTellTech');
    if (tick) tick.checked = s.tech;
    const scroll = window.scrollY;
    let view = '';
    if (s.step === 'wish') view = wishView(s, ro(), opts.meta());
    else if (s.step === 'plan') view = planView(s, ro(), opts.places());
    else if (s.step === 'check') view = checkView(s, ro());
    else view = doneView(s, ro());
    setSlot(host, 'ld-tell-body', view);
    window.scrollTo(0, scroll);
  }
  function go(step) {
    s.step = step;
    draw();
    host.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  // ── step 2: per-draft checks (one preview each, lazy, in order) ──
  async function previewCard(c) {
    c.previewing = true;
    c.previewError = null;
    c.previewFix = null;
    try {
      c.preview = await api('/api/director/preview', { method: 'POST', body: { action: c.draft.action, source: 'prompt' } });
    } catch (err) {
      if (isAbort(err)) throw err;
      c.preview = null;
      const why = refusalOf(err);
      c.previewError = why.text;
      c.previewFix = movedTo(c.draft.action, why.fixAt, err?.body?.part);
      c.previewFixAt = why.fixAt;
    } finally {
      c.previewing = false;
    }
    return c.preview;
  }
  async function previewAll() {
    for (const c of s.cards) {
      if (!ctx.alive() || c.removed || c.applied || c.draft?.status || c.preview || c.previewError) continue;
      await previewCard(c);
      if (s.step === 'plan') draw();
    }
  }
  async function suggest() {
    const wish = String($(host, '#ldWish')?.value || '').trim();
    if (!wish) { flash('WRITE WHAT SHOULD HAPPEN', 'bad'); return; }
    s.wish = wish;
    s.running = true;
    s.error = null;
    draw();
    try {
      const res = await api('/api/director/prompt', { method: 'POST', body: { wish } });
      if (!ctx.alive()) return;
      s.res = res;
      s.lastWish = wish;
      s.cards = (Array.isArray(res?.drafts) ? res.drafts : []).map((d) => ({ draft: d, preview: null, applied: false, removed: false, editable: opts.editable(d) }));
      s.running = false;
      go('plan');
      previewAll().catch(() => {});
    } catch (err) {
      if (isAbort(err) || !ctx.alive()) return;
      s.running = false;
      s.error = err.message;
      draw();
    }
  }
  function moveCard(c, action, at) {
    const { status, earliestAt, ...rest } = c.draft;
    void status; void earliestAt;
    c.draft = { ...rest, action };
    c.movedAt = Number.isSafeInteger(at) ? at : null;
    c.preview = null;
    c.previewError = null;
    c.previewFix = null;
  }

  // ── step 3: the bundle preview ──
  function newCheck(part, total, idx) {
    const k = {
      part, total, idx, main: null, bundle: null, previewing: true, error: null, errorFix: null, errorFixAt: null, applying: false,
      ticks: new Set(), cont: { main: null, read: null, reading: false, added: new Set(), rebundling: false, bundleError: null },
      shown: () => (k.cont.added.size && k.bundle ? k.bundle : k.main),
    };
    return k;
  }
  async function previewCheck() {
    const k = s.check;
    k.previewing = true;
    k.error = null;
    k.cont = { ...k.cont, main: null, read: null, added: new Set(), bundleError: null };
    k.bundle = null;
    draw();
    try {
      k.main = await api('/api/director/preview', { method: 'POST', body: { action: bundleAction(s.cards, k.idx), source: 'prompt' } });
      k.cont.main = k.main;
    } catch (err) {
      if (isAbort(err)) return;
      const why = refusalOf(err);
      k.error = why.text;
      const part = err?.body?.part;
      if (Number.isInteger(part) && k.idx[part] !== undefined) {
        const c = s.cards[k.idx[part]];
        const moved = movedTo(c.draft.action, why.fixAt);
        if (moved) { k.errorFix = { card: k.idx[part], action: moved }; k.errorFixAt = why.fixAt; }
        k.error = `change ${k.idx[part] + 1}: ${why.text}`;
      }
    }
    k.previewing = false;
    if (!ctx.alive()) return;
    draw();
    // The story read runs by itself as in the preview window: a god change in the plan, or a WARN / HIGH.
    const god = k.idx.map((i) => s.cards[i]?.draft.action?.kind).find((kind) => GOD_KINDS.has(kind));
    if (k.main && autoStoryRead({ ...k.main, action: { kind: god ?? 'bundle' } })) storyRead();
  }
  function toCheck() {
    const { bundles } = bundlesOf(s.cards);
    if (!bundles.length) return;
    s.check = newCheck(0, bundles.length, bundles[0]);
    s.applied = { groups: [], items: [], failed: [], eventCount: 0 };
    go('check');
    previewCheck();
  }
  async function storyRead() {
    const k = s.check;
    if (!k?.main || k.cont.reading) return;
    k.cont.reading = true;
    draw();
    try {
      k.cont.read = await api('/api/director/continuity', { method: 'POST', body: { previewId: k.main.previewId } });
    } catch (err) {
      k.cont.read = { status: 'failed', reason: err?.status === 429 ? 'rate' : (err?.message || 'failed').slice(0, 60) };
    }
    k.cont.reading = false;
    draw();
  }
  let rebundleTimer = null;
  function rebundle() {
    const k = s.check;
    clearTimeout(rebundleTimer);
    if (!k.cont.added.size) { k.bundle = null; k.cont.rebundling = false; k.cont.bundleError = null; draw(); return; }
    k.cont.rebundling = true;
    draw();
    rebundleTimer = setTimeout(async () => {
      const chosen = suggestionsOf(k.cont).filter((sg) => k.cont.added.has(sg.key))
        .map((sg) => ({ ...sg.action, source: sg.source === 'continuity' ? 'continuity' : 'code' }));
      try {
        k.bundle = await api('/api/director/preview', { method: 'POST', body: { action: bundleAction(s.cards, k.idx, chosen), source: 'prompt' } });
        k.cont.bundleError = null;
      } catch (err) {
        k.bundle = null;
        k.cont.bundleError = err?.message || 'refused';
      }
      k.cont.rebundling = false;
      if (ctx.alive()) draw();
    }, 400);
  }
  ctx.onDispose?.(() => clearTimeout(rebundleTimer));
  async function applyBookmarks() {
    const { after } = bundlesOf(s.cards);
    for (const i of after) {
      const c = s.cards[i];
      try {
        const p = await api('/api/director/preview', { method: 'POST', body: { action: c.draft.action, source: 'prompt' } });
        if ((p.refusals ?? []).length) throw new Error(dropText(p.refusals[0].reason));
        await api('/api/director/apply', { method: 'POST', body: { previewId: p.previewId, fingerprint: p.fingerprint } });
        c.applied = true;
        s.applied.items.push(c.draft.summary || 'a bookmark');
      } catch (err) {
        if (isAbort(err)) return;
        s.applied.failed.push(`${c.draft.summary || 'a bookmark'} — ${err.message}`);
      }
    }
  }
  async function applyCheck() {
    const k = s.check;
    const target = k.shown();
    if (!target || k.applying) return;
    k.applying = true;
    draw();
    let res = null;
    try {
      res = await api('/api/director/apply', { method: 'POST', body: { previewId: target.previewId, fingerprint: target.fingerprint } });
    } catch (err) {
      k.applying = false;
      if (isAbort(err) || !ctx.alive()) return;
      if (err?.status === 409 && /stale|expired_preview/.test(err.message)) {
        flash('HIS WORLD MOVED SINCE THIS CHECK · HERE IS A FRESH ONE — CHECK IT AGAIN', 'bad');
        await previewCheck();
      } else {
        flash(err.message, 'bad');
        draw();
      }
      return;
    }
    for (const i of k.idx) { s.cards[i].applied = true; s.applied.items.push(s.cards[i].draft.summary || upper(s.cards[i].draft.action?.kind)); }
    for (const sg of suggestionsOf(k.cont).filter((x) => k.cont.added.has(x.key))) s.applied.items.push(sg.summary || upper(sg.action?.kind));
    if (Number.isSafeInteger(res?.actionEventId)) s.applied.groups.push(res.actionEventId);
    s.applied.eventCount += Array.isArray(res?.eventIds) ? res.eventIds.length : 0;
    opts.onApplied();
    const { bundles } = bundlesOf(s.cards);
    if (bundles.length) {
      s.check = newCheck(k.part + 1, k.total, bundles[0]);
      draw();
      previewCheck();
      return;
    }
    await applyBookmarks();
    if (!ctx.alive()) return;
    s.done = { line: planLineOf(s.res, s.cards.filter((c) => c.applied)), items: s.applied.items, failed: s.applied.failed,
      groups: s.applied.groups, eventCount: s.applied.eventCount, undoing: false, undone: false };
    flash(`DONE · ${s.applied.items.length} CHANGE${s.applied.items.length === 1 ? '' : 'S'}`);
    go('done');
  }
  async function undoAll() {
    const d = s.done;
    if (!d?.groups.length || d.undoing) return;
    const previews = [];
    try {
      for (const id of [...d.groups].reverse()) {
        previews.push(await api('/api/director/revert-change', { method: 'POST', body: { actionEventId: id, group: true } }));
      }
    } catch (err) {
      if (!isAbort(err)) flash(`CAN'T UNDO · ${err.message}`, 'bad');
      return;
    }
    const words = previews.map((p) => p?.description).filter(Boolean).join('\n');
    const { ok } = await askSheet({ label: 'Undo all of this', text: words || 'Every change this story made.', action: 'UNDO ALL', danger: true });
    if (!ok || !ctx.alive()) return;
    d.undoing = true;
    draw();
    try {
      const ids = [...d.groups].reverse();
      for (let n = 0; n < ids.length; n++) {
        await api('/api/director/revert-change', { method: 'POST', body: { actionEventId: ids[n], group: true, fingerprint: previews[n].fingerprint } });
      }
      d.undone = true;
      flash('UNDONE');
      opts.onApplied();
    } catch (err) {
      if (!isAbort(err)) flash(`UNDO STOPPED · ${err.message}`, 'bad');
    }
    d.undoing = false;
    draw();
  }

  // ── events ──
  ctx.listen(host, 'input', (e) => {
    if (e.target.id === 'ldWish') { s.wish = e.target.value; setSlot(host, 'ld-tell-count', `${s.wish.length}/400`); }
  });
  ctx.listen(host, 'change', (e) => {
    const t = e.target;
    if (t.id === 'ldTellTech') { s.tech = t.checked === true; writeTech(s.tech); draw(); return; }
    if (t.classList.contains('ld-tell-tickbox') && s.check) {
      if (t.checked) s.check.ticks.add(t.dataset.tick); else s.check.ticks.delete(t.dataset.tick);
      draw();
      return;
    }
    if (t.classList.contains('ld-tell-add') && s.check) {
      if (t.checked) s.check.cont.added.add(t.dataset.key); else s.check.cont.added.delete(t.dataset.key);
      rebundle();
    }
  });
  ctx.listen(host, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || t.disabled) return;
    const c = t.dataset.card !== undefined ? s.cards[Number(t.dataset.card)] : null;
    if (t.id === 'ldSuggest') { if (!s.running) suggest(); return; }
    if (t.classList.contains('ld-tell-idea')) { s.wish = IDEAS[Number(t.dataset.idea)]?.[1] ?? s.wish; draw(); $(host, '#ldWish')?.focus(); return; }
    if (t.classList.contains('ld-tell-reopen')) { go('plan'); return; }
    if (t.classList.contains('ld-tell-back')) { go(t.dataset.to === 'wish' ? 'wish' : 'plan'); return; }
    if (t.classList.contains('ld-tell-tocheck')) { toCheck(); return; }
    if (t.classList.contains('ld-tell-again')) { s.wish = ''; s.res = null; s.cards = []; s.check = null; s.done = null; go('wish'); return; }
    if (t.classList.contains('ld-tell-undo')) { undoAll(); return; }
    if (t.classList.contains('ld-tell-read')) { storyRead(); return; }
    if (t.classList.contains('ld-tell-apply')) { applyCheck(); return; }
    if (t.classList.contains('ld-tell-keep') && s.check) {
      // KEEP IT INSTEAD: the schedule drafts of this bundle keep those plans; the check runs again.
      const keys = String(t.dataset.keys || '').split(',');
      for (const i of s.check.idx) {
        const next = keepInstead(s.cards[i].draft.action, keys);
        if (next !== s.cards[i].draft.action) s.cards[i].draft = { ...s.cards[i].draft, action: next };
      }
      previewCheck();
      return;
    }
    if (t.classList.contains('ld-tell-movepart') && s.check?.errorFix) {
      const f = s.check.errorFix;
      moveCard(s.cards[f.card], f.action, s.check.errorFixAt);
      await previewCard(s.cards[f.card]).catch(() => null);
      previewCheck();
      return;
    }
    if (!c) return;
    if (t.classList.contains('ld-p-drop')) { c.removed = true; draw(); return; }
    if (t.classList.contains('ld-tell-putback')) { c.removed = false; draw(); if (!c.preview && !c.draft.status) previewCard(c).then(draw).catch(() => {}); return; }
    if (t.classList.contains('ld-p-edit')) { opts.editCard(c); return; }
    if (t.classList.contains('ld-p-early')) {
      const moved = c.draft.status === 'too_soon' ? movedTo(c.draft.action, c.draft.earliestAt) : null;
      if (!moved) return;
      moveCard(c, moved, c.draft.earliestAt);
      draw();
      await previewCard(c).catch(() => null);
      draw();
      return;
    }
    if (t.classList.contains('ld-p-move') && c.previewFix) {
      moveCard(c, c.previewFix, c.previewFixAt);
      draw();
      await previewCard(c).catch(() => null);
      draw();
      return;
    }
    if (t.classList.contains('ld-p-open')) {
      // Technical: the old path — this draft alone, in the preview window.
      const r = await opts.openPreview(c.draft.action, { title: `CHANGE ${Number(t.dataset.card) + 1} · ${upper(c.draft.action.kind)}`, source: 'prompt' });
      if (r?.action && r.action !== c.draft.action) { c.draft = { ...c.draft, action: r.action }; c.preview = null; }
      if (r?.applied) { c.applied = true; opts.onApplied(); }
      draw();
    }
  });

  draw();
  return {
    prompt,
    renderPrompt: draw,
    previewCard,
    /** The page's poll: the panel first draws before the page knows the story's status, so a
     *  change of read-only redraws it (the wish stays in s); else only the usage line moves. */
    refresh() {
      if (ro() !== drawnRo) draw();
      else if (s.step === 'wish') setSlot(host, 'ld-prompt-meta', opts.meta());
    },
  };
}

