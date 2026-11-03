// LIFE · DIRECTOR (spec 010 T022, director-api §3–§7) — the owner's controls
// over the story: quick buttons, fate modes, sliders, pins, pause, preview
// tomorrow, rewind (event picker + hours back + bookmarks), scenes, cast/place
// edits, seed overrides, the reconciler mode and the claim tray.
//
// Every control runs a PREVIEW first (POST /api/director/preview → before/after,
// diff, the exact events apply would append, warnings, refusals) and applies
// with the preview's fingerprint (POST /api/director/apply). A stale or expired
// preview is re-previewed. The exceptions are tray reject/dismiss (one fixed
// effect, no preview). Previews are POSTs: they need write mode + CSRF, so with
// the dashboard read-only every control is disabled (the server answers 403).
//
// Suggestions from chats (spec 012 P3): advice someone gave him in a chat
// ("you should look for a new job") waits here and on the Story page. APPROVE
// (direct, nothing written to his world) pre-sets the SCENE form to an
// arc.start in that category — what happens is the owner's own scene, through
// the same preview → apply; REJECT drops it.
//
// Tell the story (spec 011, step by step since 017): pages/life-director-story.js
// — the wish, the plan in plain words, his day with it, one MAKE IT HAPPEN (one
// bundle, `source:'prompt'`), UNDO ALL OF THIS. This page mounts it and lends it
// the preview window (APPLY ONE BY ONE in its technical view) and EDIT.
//
// Relationship numbers (earned trust): NUMBERS sets a member's closeness /
// trust / tension to absolute values (blank = unchanged); the placeholders show
// the current ones. The change is split into steps of ≤ 0.2 in one apply.
//
// Weather and goals (spec 011 Phase 2): WEATHER sets an owner weather window
// (≤ 72 h ahead, 30 min – 72 h long; it replaces the forecast there only) and
// lists the open ones with END; GOALS sets a soft goal (meet / call / outing /
// errand between two days) that the engine fits into a free slot, and lists the
// open / planned ones with CANCEL. Both go through the same preview → apply.
//
// Schedule edits (spec 014, components/schedule-panel.js): SCHEDULE gives him
// a day off, WFH / office, up to three stretches (home, out, gym, errand, sleep
// in, early night) for today … +7 days; its preview lists the conflicts with a
// resolution each and shows his day before / after. A prompt `schedule` draft
// that names a real venue shows the candidates to pick from first.
//
// A refused preview reads in plain words (refusalOf); an outing he can't make in
// time (too_soon) offers MOVE TO HH:MM — the earliest start the server computed
// from getting ready + the trip — in the preview modal (and on a story card).
//
// Exports openPreview() for the other story pages (proposal approve), and
// adviceTable() / queueScenePreset() for the Story page's FROM CHATS table.
// Strings from the world, the seed, a model or a chat reach the DOM through
// html`` only.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, setSlots, slotPainter, el, $ } from '../core/dom.js';
import { fmtHm, fmtTime, fmtRelative } from '../core/fmt.js';
import { fmtDay } from '../core/fmt.js';   // 015 cont: the projection's day groups
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { askSheet } from '../components/sheet.js';
import { segments } from '../components/views.js';
import { readOnly } from './life-now.js';
import { arcsStatus, arcsOffNote, countdownText, tickCountdowns, upper, fx, finite } from './life-cast.js';
// 014 geo: the PLACES panel (search a real venue, make places real, refresh routes).
import { placesPanelShell, mountPlacesPanel } from '../components/placesPanel.js';
import { mountSchedulePanel, scheduleDraftVenues } from '../components/schedule-panel.js';   // 014 sched
import { mountGodPanel } from './life-director-god.js';   // 015: PLAY GOD
import { storyShell, mountStoryPanel } from './life-director-story.js';   // 017: TELL THE STORY, step by step

const POLL_MS = 30_000;
const JSON_MAX = 220;

// The closed catalogue (the server re-validates everything).
export const QUICK = [
  ['tired', 'TIRED'], ['energised', 'ENERGISED'], ['free_evening', 'FREE EVENING'], ['cancel_tonight', 'CANCEL TONIGHT'],
  ['rain', 'RAIN'], ['sick_day', 'SICK DAY'], ['bad_day_at_work', 'BAD DAY AT WORK'], ['good_day_at_work', 'GOOD DAY AT WORK'],
];
export const CATEGORIES = ['romance', 'career', 'family', 'cast', 'health', 'social', 'heavy'];
export const FATE_MODES = ['natural', 'guided', 'frozen'];
export const SLIDERS = ['drama', 'romanceAppetite', 'careerAmbition', 'familyPressure', 'socialAppetite', 'heavyLikelihood'];
export const RECONCILER_MODES = ['auto', 'review', 'off'];
const SEED_PATHS = ['career.appraisalMonth', 'career.noticeDays', 'career.salaryChangePct.min', 'career.salaryChangePct.max', 'family.callCadenceDays'];
const ROMANCE_STAGES = ['single', 'interested', 'talking', 'dating', 'committed', 'engaged', 'married'];
const ARC_KINDS = { romance: ['romance'], career: ['hunt'], family: ['occasion', 'major'], cast: ['friendship'], health: ['fitness'], social: ['social'] };
const HEAVY_KINDS = ['family_illness', 'breakup', 'friend_moving_away', 'pet_loss', 'minor_accident', 'money_setback'];
const BEAT_KINDS = ['status', 'away', 'back', 'hobby', 'news', 'milestone', 'trip'];
const NEW_CAST_RELATIONS = ['friend', 'acquaintance', 'neighbour', 'coworker'];
const CAST_EDIT_FIELDS = [['status', 160], ['availability', 160], ['job', 60], ['employer', 80], ['personality', 200], ['speech', 160], ['pronouns', 24], ['hometown', 80]];
const METRIC_FIELDS = ['closeness', 'trust', 'tension'];
export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'storm', 'heat'];
export const GOAL_KINDS = ['meet', 'call', 'outing', 'errand'];

// Scene shapes → their fields: [name, type, opts]. Types: text(max) int(lo,hi,dflt) float(lo,hi)
// select(options) cast place casts startIn(minutes from now) daysAhead daysAgo.
const SCENES = {
  outing: [['placeId', 'place'], ['castIds', 'casts'], ['startIn', 'startIn'], ['minutes', 'int', [15, 360, 90]], ['label', 'text', [80]]],
  visit: [['castIds', 'casts'], ['startIn', 'startIn'], ['minutes', 'int', [15, 360, 120]]],
  'cast.beat': [['castId', 'cast'], ['beatKind', 'select', BEAT_KINDS], ['text', 'text', [120]], ['until', 'daysAhead', { optional: true }]],
  'cast.history': [['castId', 'cast'], ['text', 'text', [160]], ['dated', 'daysAgo', { optional: true }]],
  new_cast: [['name', 'text', [40]], ['relation', 'select', NEW_CAST_RELATIONS], ['pronouns', 'text', [24, true]], ['personality', 'text', [200, true]], ['status', 'text', [160, true]], ['metVia', 'cast', { optional: true }]],
  new_place: [['name', 'text', [60]], ['placeKind', 'text', [24]], ['near', 'place'], ['offsetKm', 'float', [0, 5]]],
  'arc.start': [['category', 'select', Object.keys(ARC_KINDS)], ['arcKind', 'select', [...new Set(Object.values(ARC_KINDS).flat())]], ['castIds', 'casts']],
  'arc.stage': [['arcId', 'int', [1, 1e12, '']], ['to', 'select', ROMANCE_STAGES]],
  heavy: [['heavyKind', 'select', HEAVY_KINDS], ['label', 'text', [80]], ['durationDays', 'int', [1, 30, 7]], ['castId', 'cast', { optional: true }]],
};

const nowSec = () => Math.floor(Date.now() / 1000);
const short = (v) => {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined) s = '—';
  return s.length > JSON_MAX ? `${s.slice(0, JSON_MAX)}…` : s;
};
const opt = (value, label, selected) => html`<option value="${value}" ${selected ? 'selected' : ''}>${label ?? value}</option>`;
const dis = (ro) => (ro ? 'disabled' : '');

// ── the preview modal (shared) ─────────────────────────────────────────────

// 015: the continuity warnings of a preview ({warnings, threads, suggestions}: the
// planner's own relaxed-refusal codes first, then the checker's C-rules).
export const continuityOf = (p) => (Array.isArray(p?.continuity?.warnings) ? p.continuity.warnings.filter((w) => w && typeof w.code === 'string') : []);

function previewBody(p, { title, note, cont = null }) {
  const events = Array.isArray(p.events) ? p.events : [];
  const changes = events.filter((e) => e.type !== 'director.action');
  const warnings = Array.isArray(p.warnings) ? p.warnings : [];
  const refusals = Array.isArray(p.refusals) ? p.refusals : [];
  const diff = Array.isArray(p.diff) ? p.diff : [];
  const x = p.extra || null;
  return html`<div class="story-modal-card" tabindex="-1">
    <div class="panel-head"><span>PREVIEW · ${title}</span><span class="mono mute">EXPIRES IN <b data-countdown="${p.expiresAt}">${countdownText(p.expiresAt)}</b></span></div>
    <div class="panel-body">
      ${note ? html`<div class="story-note amber mono">${note}</div>` : ''}
      ${warnings.length ? html`<ul class="story-warnings">${warnings.map((w) => html`<li class="amber">⚠ ${w}</li>`)}</ul>` : ''}
      ${refusals.length ? html`<div class="story-refusals"><b class="red">REFUSED</b>${refusals.map((r) => html` <span class="chip bad">${r.reason}${r.target ? ` · ${r.target}` : ''}${r.pinKey ? ` · pin ${r.pinKey}` : ''}${Number.isInteger(r.part) ? ` · part ${r.part + 1}` : ''}</span>`)}</div>` : ''}
      ${cont ? continuityView(p, cont) : ''}
      ${x ? html`<div class="story-extra mono">${finite(x.routineCount) ? html`<span>${x.routineCount} routine events undone</span> ` : ''}${x.cancelled ? html`<span>cancelled: ${short(x.cancelled)}</span> ` : ''}${x.mismatched ? html`<span class="amber">replies that may no longer match: ${short(x.mismatched)}</span>` : ''}</div>` : ''}
      <div class="story-sub mono">CHANGES (${diff.length})</div>
      ${diff.length ? html`<table class="data story-diff"><thead><tr><th>PATH</th><th>BEFORE</th><th>AFTER</th></tr></thead><tbody>
        ${diff.slice(0, 100).map((d) => html`<tr><td class="mono">${d.path}</td><td class="mono mute">${short(d.from)}</td><td class="mono">${short(d.to)}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">NO STATE CHANGE</div>`}
      <div class="story-sub mono">EVENTS APPLY WOULD APPEND (${events.length})</div>
      <ol class="story-events mono">${events.map((e) => html`<li><b>${e.ref || ''}</b> ${e.type} <span class="chip">${e.actor}</span>${e.causeRef ? html` <span class="mute">← ${e.causeRef}</span>` : ''}${e.heavy ? html` <span class="chip bad">HEAVY</span>` : ''}
        <div class="story-payload mute">${short(e.payload)}</div></li>`)}</ol>
    </div>
    <div class="story-modal-foot">
      <button type="button" data-act="close">CANCEL</button>
      ${cont ? applyButtons(cont) : html`<button type="button" class="primary" data-act="apply" ${changes.length ? '' : 'disabled'}>${changes.length ? `APPLY ${events.length} EVENT${events.length === 1 ? '' : 'S'}` : 'NOTHING TO APPLY'}</button>`}
    </div>
  </div>`;
}

// ── 015 cont: continuity in the preview (warnings, story read, what changes ahead, threads, suggestions) ──
//
// Code warnings come with every preview; the STORY READ (one mind call, its own
// day cap and budget) runs once by itself for the life-changing kinds or a
// warning ≥ WARN — never for a preview that cancels or keeps a chat plan (button only).
// ADD on a suggestion re-previews the change as ONE batch (bundle) with the
// chosen suggestions; APPLY AS-IS applies the change alone, APPLY WITH n applies
// the batch. A HIGH warning asks for one tick before either. Everything a model
// wrote is shown as text (html``), and a suggestion's free text verbatim.

const GOD_KINDS = new Set(['decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return', 'retcon']);
// The planner's lines about a chat-made plan (cancelled, told or not, or kept): no automatic story read
// then. A prefix: director.js says how each line ends (test: arcs 33 runs every constant through this).
const CHAT_PLAN_PREFIXES = ['cancels a plan made in a chat', 'keeps a plan made in a chat'];
// A schedule edit's own conflict lines (a cancel, a plan kept by trimming): the code
// already says it all, so they alone never start a story read (a model call).
const OWN_CONFLICT_CODES = new Set(['cancels_plan', 'keeps_plan', 'overlaps_plan', 'overrides_open_chat', 'messages_real_person']);
const SEV_CHIP = { high: 'bad', warn: 'warn', info: '' };
const sevOrder = { high: 0, warn: 1, info: 2 };
const highCodes = (p) => [...new Set((p?.continuity?.warnings ?? []).filter((w) => w.severity === 'high').map((w) => w.code))];

// A schedule edit — or an owner outing / visit set up over a plan — that cancels
// a plan carries the conflict keys (cancels_plan `keep`): KEEP IT INSTEAD previews
// the same change with those rows on 'keep' (a schedule range is trimmed around
// the plan; an outing leaves both planned). A bundle / retcon: those parts.
const KEEP_KEY_RE = /^(?:decision|goal|invite):\d{1,15}$/;
const keepable = (a) => a?.kind === 'schedule' || (a?.kind === 'scene' && (a.shape === 'outing' || a.shape === 'visit'));
export function keepInstead(action, keys) {
  const list = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && KEEP_KEY_RE.test(k));
  if (!action || typeof action !== 'object' || !list.length) return action;
  const one = (a) => (keepable(a) ? { ...a, resolutions: { ...(a.resolutions ?? {}), ...Object.fromEntries(list.map((k) => [k, 'keep'])) } } : a);
  if ((action.kind === 'bundle' || action.kind === 'retcon') && Array.isArray(action.actions)) return { ...action, actions: action.actions.map(one) };
  return one(action);
}
const keepLabel = (w) => `KEEP ${w.keep.length === 1 ? 'IT' : 'THEM'} INSTEAD`;

/** Should the story read run by itself for this (main) preview? */
export function autoStoryRead(p) {
  if (!p || (p.warnings ?? []).some((w) => CHAT_PLAN_PREFIXES.some((c) => String(w).startsWith(c)))) return false;
  if (!(p.events ?? []).some((e) => e.type !== 'director.action')) return false;
  if ((p.continuity?.warnings ?? []).some((w) => w.code === 'messages_real_person')) return false;
  const kind = p.action?.kind ?? p.kind;
  return GOD_KINDS.has(kind) || (p.continuity?.warnings ?? []).some((w) => (w.severity === 'warn' || w.severity === 'high') && !OWN_CONFLICT_CODES.has(w.code));
}

/** Every suggestion of the modal: code ones first (key c<i>), then the story read's (r<i>). */
export function suggestionsOf(cont) {
  const code = (cont.main?.continuity?.suggestions ?? []).map((sg, i) => ({ ...sg, key: `c${i}`, source: 'code' }));
  const read = (cont.read?.status === 'ok' ? cont.read.suggestions ?? [] : []).map((sg, i) => ({ ...sg, key: `r${i}`, source: 'continuity' }));
  return [...code, ...read];
}

/** The batch "main + the added suggestions": a bundle (a retcon / bundle main takes them as extra parts). */
export function withSuggestions(main, added) {
  const parts = added.map((sg) => ({ ...sg.action, source: sg.source === 'continuity' ? 'continuity' : 'code' }));
  if (main.kind === 'retcon' || main.kind === 'bundle') return { ...main, actions: [...(main.actions ?? []), ...parts].slice(0, 5) };
  return { kind: 'bundle', actions: [{ ...main, source: 'hand' }, ...parts].slice(0, 5) };
}

function warningRow(w, ro = false) {
  const refs = [...(w.refs?.castIds ?? []), ...(w.refs?.decisionIds ?? []).map((id) => `decision #${id}`), ...(w.refs?.goalIds ?? []).map((id) => `goal #${id}`)];
  const keep = Array.isArray(w.keep) && w.keep.length;
  return html`<li class="cont-warning"><span class="chip ${SEV_CHIP[w.severity] ?? ''}">${upper(w.severity)}</span> <span class="mono mute">${w.code}</span> ${keep ? html`<b class="red">${w.text}</b>` : w.text}${w.fromChat ? html` <span class="mute">· from a chat</span>` : ''}${refs.length ? html` <span class="mono mute cont-refs">${refs.join(', ')}</span>` : ''}${Number.isInteger(w.fix) ? html` <span class="mute">· suggestion ${w.fix + 1}</span>` : ''}${keep ? html` <button type="button" class="cont-keep" data-act="keep-instead" data-keys="${w.keep.join(',')}" ${ro ? 'disabled' : ''}>${keepLabel(w)}</button>` : ''}</li>`;
}

function readView(cont) {
  if (cont.reading) return html`<div class="cont-read mono mute">STORY READ · READING…</div>`;
  const r = cont.read;
  if (!r) return html`<div class="cont-read"><button type="button" data-act="read">STORY READ</button> <span class="mono mute">ONE MODEL CALL · FICTIONAL PEOPLE AND PLACES ONLY, NEVER CHATS</span></div>`;
  if (r.status !== 'ok') return html`<div class="cont-read mono mute">story read unavailable (${r.reason || r.status}) — code checks only</div>`;
  return html`<div class="cont-read"><div class="story-sub mono">FROM THE STORY READ${r.cached ? ' · CACHED' : ''}${r.fellBack ? ' · FALLBACK MODEL' : ''}</div>
    ${r.warnings?.length ? html`<ul class="story-warnings cont-read-list">${r.warnings.map((w) => html`<li><span class="chip ${SEV_CHIP[w.severity] ?? ''}">${upper(w.severity)}</span> <i class="mute">${w.text}</i></li>`)}</ul>` : html`<div class="mono mute">NOTHING MORE TO ADD</div>`}</div>`;
}

const CHANGE_MARK = { added: '+', removed: '−', moved: '→', same: '·' };

function aheadView(pr) {
  if (!pr) return '';
  if (pr.skipped) return html`<div class="story-sub mono">WHAT CHANGES AHEAD</div><div class="mono mute">projection skipped (${pr.skipped})</div>`;
  const rows = Array.isArray(pr.rows) ? pr.rows : [];
  const groups = new Map();
  for (const r of rows) {
    const day = fmtDay(r.at);
    const label = day === pr.today ? 'TODAY' : 'TOMORROW';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  const changed = rows.filter((r) => r.change !== 'same').length;
  const decisions = (pr.decisions ?? []).filter((d) => d.before !== d.after);
  return html`<div class="story-sub mono">WHAT CHANGES AHEAD (${changed} CHANGE${changed === 1 ? '' : 'S'})</div>
    ${[...groups.entries()].map(([label, list]) => html`<div class="cont-day mono">${label}</div>
      <table class="data cont-ahead"><tbody>${list.map((r) => html`<tr class="cont-${r.change}">
        <td class="mono">${CHANGE_MARK[r.change] ?? ''}</td><td class="mono">${fmtHm(r.at)}–${fmtHm(r.end)}${r.change === 'moved' && r.wasAt ? html` <span class="mute">(was ${fmtHm(r.wasAt)})</span>` : ''}</td>
        <td>${r.kind}</td><td>${r.place ?? ''}</td><td class="mute">${(r.cast ?? []).join(', ')}</td></tr>`)}</tbody></table>`)}
    ${decisions.length ? html`<div class="cont-decisions mono">${decisions.map((d) => html`<div>${d.label}: <b>${d.before ?? '—'}</b> → <b>${d.after ?? '—'}</b> <span class="mute">${d.at ? fmtHm(d.at) : ''}</span></div>`)}</div>` : ''}
    <div class="mono mute cont-numbers">MONEY ${pr.money?.before ?? '—'} → ${pr.money?.after ?? '—'} (LOWEST ${pr.money?.min ?? '—'}) · ENERGY AT SLEEP ${pr.energyAtSleep?.before ?? '—'} → ${pr.energyAtSleep?.after ?? '—'}</div>`;
}

function threadsView(c) {
  const list = c?.threads ?? [];
  if (!list.length) return '';
  return html`<div class="story-sub mono">OPEN THREADS (${list.length})</div><table class="data cont-threads">
    <thead><tr><th>KIND</th><th>WHAT</th><th>WHEN</th><th>FATE</th></tr></thead><tbody>
    ${list.map((t) => html`<tr><td class="mono">${t.kind}</td><td>${t.label}</td><td class="mono">${t.at ? fmtHm(t.at) : '—'}</td><td class="mono ${t.fate === 'cancelled' || t.fate === 'conflict' ? 'amber' : ''}">${upper(t.fate)}</td></tr>`)}
    </tbody></table>`;
}

function suggestionView(sg, added, ro) {
  const on = added.has(sg.key);
  const texts = Array.isArray(sg.texts) ? sg.texts : [];
  return html`<li class="cont-suggestion ${on ? 'on' : ''}">
    <label><input type="checkbox" data-act="add" data-key="${sg.key}" ${on ? 'checked' : ''} ${ro ? 'disabled' : ''}> ADD</label>
    <span class="chip">${sg.source === 'continuity' ? 'STORY READ' : 'CODE'}</span>
    <b class="mono">${sg.summary || upper(sg.action?.kind)}</b>${sg.why ? html` <span class="mute">— ${sg.why}</span>` : ''}
    ${texts.length ? html`<div class="cont-texts mono">${texts.map((t) => html`<div><span class="mute">${t.field}:</span> ${t.value}</div>`)}</div>` : html`<div class="cont-texts mono mute">no free text</div>`}
    ${(sg.refusals ?? []).length ? html`<div class="red mono">${sg.refusals.map((r) => r.reason).join(', ')}</div>` : ''}
  </li>`;
}

/** The continuity sections of a preview: warnings + story read, what changes ahead, threads, suggestions. */
export function continuityView(p, cont) {
  const c = p.continuity ?? null;
  const warnings = [...(c?.warnings ?? [])].sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
  const sgs = suggestionsOf(cont);
  const ro = cont.readOnly === true;
  return html`<div class="cont">
    <div class="story-sub mono">CONTINUITY (${warnings.length} WARNING${warnings.length === 1 ? '' : 'S'}) · WARNINGS NEVER BLOCK</div>
    ${warnings.length ? html`<ul class="story-warnings cont-warnings">${warnings.map((w) => warningRow(w, ro))}</ul>` : html`<div class="mono mute">NO BREAK FOUND BY THE CODE CHECKS</div>`}
    ${readView(cont)}
    ${aheadView(p.projection)}
    ${threadsView(c)}
    ${sgs.length ? html`<div class="story-sub mono">SUGGESTIONS (${sgs.length})${cont.rebundling ? ' · RE-PREVIEWING…' : ''}</div>
      <ul class="cont-suggestions">${sgs.map((sg) => suggestionView(sg, cont.added, ro))}</ul>
      ${cont.bundle?.error ? html`<div class="red mono">WITH SUGGESTIONS: ${cont.bundle.error}</div>` : ''}` : ''}
    ${highCodes(p).length ? html`<label class="cont-tick amber mono"><input type="checkbox" data-act="tick" ${cont.tick ? 'checked' : ''}> I KNOW: ${highCodes(p).join(', ')}</label>` : ''}
  </div>`;
}

function applyButtons(cont) {
  const main = cont.main;
  const n = cont.added.size;
  const changes = (main?.events ?? []).filter((e) => e.type !== 'director.action').length;
  const needTick = (p) => highCodes(p).length > 0 && !cont.tick;
  const bundle = cont.bundle && !cont.bundle.error ? cont.bundle : null;
  return html`<button type="button" class="primary" data-act="apply" ${changes && !needTick(main) ? '' : 'disabled'}>${changes ? 'APPLY AS-IS' : 'NOTHING TO APPLY'}</button>
    ${n ? html`<button type="button" class="primary" data-act="apply-with" ${bundle && !cont.rebundling && !needTick(bundle) ? '' : 'disabled'}>APPLY WITH ${n} SUGGESTION${n === 1 ? '' : 'S'}</button>` : ''}`;
}

// A refused preview in plain words. too_soon carries `earliestAt` (the server's
// first start he can still get ready for and get to) → { text, fixAt }.
export function refusalOf(err) {
  const b = err?.body && typeof err.body === 'object' ? err.body : {};
  const at = Number.isSafeInteger(b.earliestAt) && b.earliestAt > 0 ? b.earliestAt : null;
  if (b.error === 'too_soon') {
    return { text: at ? `he can't get there in time — the earliest he could arrive is ${fmtHm(at)}` : 'he can\'t get there in time', fixAt: at };
  }
  if (b.error === 'no_route') return { text: 'he has no way to get there from where he is (no route to that place)', fixAt: null };
  if (b.error === 'real_person' || b.reason === 'real_person') return { text: 'this plan is with a real person: it takes only a pick or a cancel', fixAt: null };
  return { text: err?.message || 'refused', fixAt: null };
}

// The action with its outing moved to start at `at` (a scene, a tray adoption, or
// the refused part of a bundle / retcon); null when there is no start to move.
const MOVABLE_KINDS = new Set(['scene', 'tray.adopt']);
export function movedTo(action, at, part = null) {
  if (!action || typeof action !== 'object' || !Number.isSafeInteger(at)) return null;
  if ((action.kind === 'bundle' || action.kind === 'retcon') && Array.isArray(action.actions)) {
    const inner = Number.isInteger(part) ? movedTo(action.actions[part], at) : null;
    if (!inner) return null;
    const actions = action.actions.slice();
    actions[part] = inner;
    return { ...action, actions };
  }
  if (!MOVABLE_KINDS.has(action.kind)) return null;
  const { when, ...rest } = action;
  void when;
  return { ...rest, startAt: at };
}

/**
 * Preview `action`, show it, apply on confirm. Resolves { applied, result, action }
 * (`action` as last previewed: MOVE TO may have moved its start).
 * The modal is removed when the page goes away (ctx.onDispose).
 */
export function openPreview(ctx, action, { title = upper(action?.kind), onApplied = null, source = null } = {}) {
  return new Promise((resolve) => {
    const box = el('div', { class: 'story-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Director preview: ${title}` });
    document.body.appendChild(box);
    let current = null;
    let busy = false;
    let done = false;
    let move = null;   // a too_soon refusal's fix: the action moved to the earliest start
    // 015 cont: the modal's continuity state (main preview, story read, chosen suggestions, the batch preview).
    const cont = { main: null, read: null, reading: false, added: new Set(), bundle: null, rebundling: false, tick: false, timer: null, readOnly: readOnly(), note: '' };
    const ticker = setInterval(() => tickCountdowns(box), 1000);
    const close = (applied = false, result = null) => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      clearTimeout(cont.timer);
      document.removeEventListener('keydown', onKey);
      box.remove();
      resolve({ applied, result, action });
    };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(false); };   // a sheet above it answers its own Escape
    document.addEventListener('keydown', onKey);
    ctx.onDispose(() => close(false));

    async function run(note = '') {
      render(box, html`<div class="story-modal-card"><div class="loading">PREVIEWING · NOTHING IS WRITTEN</div></div>`);
      try {
        current = await api('/api/director/preview', { method: 'POST', body: { action, ...(source ? { source } : {}) } });
      } catch (err) {
        if (done) return;
        const why = refusalOf(err);
        move = movedTo(action, why.fixAt, err?.body?.part);
        const hm = move ? fmtHm(why.fixAt) : '';
        render(box, html`<div class="story-modal-card"><div class="panel-body"><b class="red">PREVIEW REFUSED</b><p class="mono">${why.text}</p>
          ${move ? html`<p class="mute">MOVE TO ${hm} previews it again starting then. Nothing is written until you apply.</p>` : ''}</div>
          <div class="story-modal-foot">${move ? html`<button type="button" class="primary" data-act="move" ${readOnly() ? 'disabled' : ''}>MOVE TO ${hm}</button> ` : ''}<button type="button" data-act="close">CLOSE</button></div></div>`);
        return;
      }
      if (done) return;
      Object.assign(cont, { main: current, read: null, reading: false, bundle: null, rebundling: false, tick: false, note });
      cont.added.clear();
      draw();
      $(box, '.story-modal-card')?.focus?.();
      if (autoStoryRead({ ...current, action })) storyRead();
    }

    // 015 cont: redraw with the batch preview when suggestions are added (sections 1–4 swap to it).
    function draw() {
      if (done || !cont.main) return;
      const shown = cont.added.size && cont.bundle && !cont.bundle.error ? cont.bundle : cont.main;
      const scroll = $(box, '.story-modal-card')?.scrollTop ?? 0;
      render(box, previewBody(shown, { title: cont.added.size ? `${title} · WITH ${cont.added.size} SUGGESTION${cont.added.size === 1 ? '' : 'S'}` : title, note: cont.note, cont }));
      const card = $(box, '.story-modal-card');
      if (card) card.scrollTop = scroll;
    }
    async function storyRead() {
      if (cont.reading || !cont.main) return;
      cont.reading = true;
      draw();
      try {
        cont.read = await api('/api/director/continuity', { method: 'POST', body: { previewId: cont.main.previewId } });
      } catch (err) {
        cont.read = { status: 'failed', reason: err?.status === 429 ? 'rate' : (err?.message || 'failed').slice(0, 60) };
      }
      cont.reading = false;
      draw();
    }
    function rebundle() {
      clearTimeout(cont.timer);
      if (!cont.added.size) { cont.bundle = null; cont.rebundling = false; draw(); return; }
      cont.rebundling = true;
      draw();
      cont.timer = setTimeout(async () => {
        const chosen = suggestionsOf(cont).filter((sg) => cont.added.has(sg.key));
        try {
          const res = await api('/api/director/preview', { method: 'POST', body: { action: withSuggestions(action, chosen), ...(source ? { source } : {}) } });
          cont.bundle = res;
        } catch (err) {
          cont.bundle = { error: err?.message || 'refused' };
        }
        cont.rebundling = false;
        draw();
      }, 400);
    }

    box.addEventListener('click', async (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (e.target === box || act === 'close') { close(false); return; }
      if (act === 'move' && move) { action = move; move = null; run('MOVED TO THE EARLIEST START HE CAN MAKE'); return; }
      // A cancel the owner didn't mean: the same edit with those plans kept (re-previewed).
      if (act === 'keep-instead') {
        const next = keepInstead(action, String(e.target.closest('[data-act]')?.dataset.keys || '').split(','));
        if (next !== action) { action = next; run(action.kind === 'scene' ? 'KEPT INSTEAD · BOTH PLANS STAY' : 'KEPT INSTEAD · THE RANGE IS TRIMMED AROUND IT'); }
        return;
      }
      // 015 cont: story read, ADD a suggestion, the HIGH tick.
      if (act === 'read') { storyRead(); return; }
      if (act === 'add') {
        const key = e.target.dataset.key;
        if (cont.added.has(key)) cont.added.delete(key); else cont.added.add(key);
        rebundle();
        return;
      }
      if (act === 'tick') { cont.tick = e.target.checked === true; draw(); return; }
      if ((act !== 'apply' && act !== 'apply-with') || busy || !current) return;
      const target = act === 'apply-with' ? cont.bundle : cont.main;
      if (!target || target.error) return;
      if (action.kind === 'retcon') {
        const n = target.extra?.cancelled?.total ?? 0;
        const { ok } = await askSheet({
          label: 'Rewrite the past',
          text: `${n} events after the rewind point are set aside (never deleted), then the change happens now. A rewind is permanent bookkeeping. Go ahead?`,
          action: 'REWRITE', danger: true,
        });
        if (!ok || done || busy) return;
      }
      busy = true;
      e.target.disabled = true;
      try {
        const res = await api('/api/director/apply', { method: 'POST', body: { previewId: target.previewId, fingerprint: target.fingerprint } });
        flash(`APPLIED · ${res?.eventIds?.length ?? 0} EVENTS`);
        close(true, res);
        if (typeof onApplied === 'function' && ctx.alive()) onApplied(res);
      } catch (err) {
        busy = false;
        if (done) return;
        if (err?.status === 409 && /stale|expired_preview/.test(err.message)) {
          await run('THE WORLD MOVED SINCE THIS PREVIEW · HERE IS A FRESH ONE');
        } else {
          flash(err.message, 'bad');
          e.target.disabled = false;
        }
      }
    });
    run();
  });
}

// ── sections ───────────────────────────────────────────────────────────────

// One long page of forms is too much on a phone: a strip shows one section at a time. Every
// form stays in the DOM, so a section switch keeps what was typed. A phone opens on TELL, a
// desktop on ALL (the whole page, as it always was); the choice is remembered per browser.
// #life/director/<section> opens one directly, without changing what is remembered.
const SECTIONS = [['tell', 'TELL'], ['day', 'DAY'], ['build', 'BUILD'], ['god', 'GOD'], ['controls', 'CONTROLS'], ['all', 'ALL']];
const SEG_KEY = 'ld.director.seg';
const validSection = (k) => SECTIONS.some(([s]) => s === k);

function sectionStrip(root, linked, paintSlot) {
  let remembered = null;
  try { remembered = localStorage.getItem(SEG_KEY); } catch { /* blocked storage: the default */ }
  const phone = globalThis.matchMedia?.('(max-width: 899px)').matches === true;
  let show = validSection(linked) ? linked : validSection(remembered) ? remembered : phone ? 'tell' : 'all';
  let waiting = 0;
  const dir = root.querySelector('.ld-dir');
  const strip = root.querySelector('[data-slot="ld-seg"]');
  const paint = () => {
    dir.dataset.show = show;
    paintSlot('ld-seg', segments(SECTIONS.map(([k, t]) => [k, t, k === 'controls' ? waiting : 0]), show, { label: 'Director sections' }));
    // Too narrow for all of them: keep the one that's on in view.
    const bar = strip.querySelector('.seg');
    const on = bar?.querySelector('.is-on');
    if (on) bar.scrollLeft = on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2;
  };
  paint();
  return {
    choose(k) {
      if (!validSection(k)) return;
      show = k;
      try { localStorage.setItem(SEG_KEY, k); } catch { /* not remembered, then */ }
      paint();
      // Deep in a long section the strip is stuck to the top: start the new one under it.
      const under = strip.getBoundingClientRect().bottom + 8;
      const top = dir.getBoundingClientRect().top;
      if (top < under) window.scrollBy(0, top - under);
    },
    setWaiting(n) { waiting = n; paint(); },
    /** Show a form something just filled in (its section first; what is remembered doesn't change). */
    reveal(node) {
      const sec = node.closest('[data-sec]')?.dataset.sec;
      if (show !== 'all' && sec && sec !== show) { show = sec; paint(); }
      node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    },
  };
}

// ── page shell ─────────────────────────────────────────────────────────────

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · DIRECTOR · PREVIEW, THEN APPLY <button type="button" class="guide-q" data-guide="recipes" aria-label="Guide: recipes">? HOW DO I…</button></div>
    <h1>Director</h1>
  </div>
  <div class="meta">
    <span>STORY <b data-slot="ld-paused">—</b></span>
    <span>RECONCILER <b data-slot="ld-mode">—</b></span>
    <span>SEED <b data-slot="ld-seed">—</b></span>
    <span>TRAY <b class="amber" data-slot="ld-tray">—</b></span>
    <span>REFUSALS 24 H <b data-slot="ld-ref24">—</b></span>
  </div>
</div>
<div data-slot="ld-off"></div>
<div data-slot="ld-ro"></div>
<div class="ld-seg" data-slot="ld-seg"></div>
<div class="ld-dir" data-show="all">

${storyShell()}

<div class="panel god" data-panel="god" data-sec="god" data-wide>
  <div class="panel-head"><span>PLAY GOD<button type="button" class="guide-q" data-guide="god" aria-label="Guide: play god">?</button></span><span class="mono mute">REWRITE HIS FUTURE · PREVIEW, THEN APPLY · WARNINGS NEVER BLOCK</span></div>
  <div class="panel-body" data-slot="ld-god"></div>
</div>

<div class="panel" data-sec="day">
  <div class="panel-head"><span>QUICK<button type="button" class="guide-q" data-guide="quick" aria-label="Guide: quick">?</button></span><span class="mono mute">OWNER EVENTS · FIXED TEMPLATES</span></div>
  <div class="panel-body story-buttons" data-slot="ld-quick"></div>
</div>

<div class="col-2">
  <div class="panel" data-panel="controls" data-sec="controls">
    <div class="panel-head"><span>FATE · SLIDERS · PAUSE<button type="button" class="guide-q" data-guide="fate" aria-label="Guide: fate">?</button></span><span class="mono mute" data-slot="ld-budget"></span></div>
    <div class="panel-body" data-slot="ld-controls"></div>
  </div>
  <div class="panel" data-sec="controls">
    <div class="panel-head"><span>PINS<button type="button" class="guide-q" data-guide="pins" aria-label="Guide: pins">?</button></span><span class="mono mute">A PIN BLOCKS ENGINE, MIND AND RECONCILER</span></div>
    <div class="panel-body" data-slot="ld-pins"></div>
  </div>
</div>

<div class="panel" style="margin-top:14px" data-sec="controls" data-wide>
  <div class="panel-head"><span>CLAIM TRAY · WHAT HE SAID THAT THE WORLD HAS NOT ADOPTED<button type="button" class="guide-q" data-guide="tray" aria-label="Guide: tray">?</button></span><span class="mono mute">ADOPT = PREVIEW · REJECT / DISMISS = DIRECT</span></div>
  <div data-slot="ld-tray-rows"></div>
</div>

<div class="panel" style="margin-top:14px" data-sec="controls" data-wide>
  <div class="panel-head"><span>SUGGESTIONS FROM CHATS · ADVICE ABOUT HIS LIFE<button type="button" class="guide-q" data-guide="advice" aria-label="Guide: advice">?</button></span><span class="mono mute">APPROVE = PRESET THE SCENE · NOTHING CHANGES UNTIL YOU APPLY</span></div>
  <div data-slot="ld-advice-rows"></div>
</div>

<div class="col-2">
  <div class="panel" data-sec="build">
    <div class="panel-head"><span>SCENE<button type="button" class="guide-q" data-guide="scene" aria-label="Guide: scene">?</button></span><span class="mono mute">OWNER-AUTHORED · VISIBLE IN EVERY CHAT</span></div>
    <div class="panel-body">
      <div class="story-form-row"><label>SHAPE <select id="ldShape" aria-label="Scene shape">${Object.keys(SCENES).map((s) => opt(s, upper(s)))}</select></label></div>
      <form id="ldScene" class="story-form" autocomplete="off"></form>
      <button type="button" class="primary" id="ldScenePreview">PREVIEW SCENE</button>
    </div>
  </div>
  <div class="panel" data-sec="day">
    <div class="panel-head"><span>PREVIEW TOMORROW<button type="button" class="guide-q" data-guide="tomorrow" aria-label="Guide: tomorrow">?</button></span><span class="mono mute">SIMULATED · NO MODEL CALLS · NOTHING WRITTEN</span></div>
    <div class="panel-body"><button type="button" id="ldTomorrow">PREVIEW THE NEXT 24 H</button><div data-slot="ld-tomorrow"></div></div>
  </div>
</div>

<div class="col-2">
  <div class="panel" data-sec="build">
    <div class="panel-head"><span>WEATHER<button type="button" class="guide-q" data-guide="weather" aria-label="Guide: weather">?</button></span><span class="mono mute">REPLACES THE FORECAST IN THAT WINDOW ONLY</span></div>
    <div class="panel-body">
      <form id="ldWeather" class="story-form" autocomplete="off">
        <label>SKY <select name="weatherKind" aria-label="Weather kind">${WEATHER_KINDS.map((k) => opt(k, upper(k)))}</select></label>
        <label>INTENSITY <input type="range" name="intensity" min="0" max="1" step="0.1" value="0.5" aria-label="Intensity"></label>
        <label>FROM IN (HOURS) <input type="number" name="fromHours" min="0" max="71" step="1" value="0"></label>
        <label>LASTING (HOURS) <input type="number" name="hours" min="0.5" max="72" step="0.5" value="3"></label>
      </form>
      <button type="button" class="primary" id="ldWeatherGo">PREVIEW WEATHER</button>
      <div class="story-sub mono">OPEN WINDOWS</div>
      <div data-slot="ld-windows"></div>
    </div>
  </div>
  <div class="panel" data-sec="build">
    <div class="panel-head"><span>GOALS<button type="button" class="guide-q" data-guide="goals" aria-label="Guide: goals">?</button></span><span class="mono mute">FITTED INTO A FREE SLOT · ONE TRY A DAY</span></div>
    <div class="panel-body">
      <form id="ldGoal" class="story-form" autocomplete="off">
        <label>KIND <select name="goalKind" aria-label="Goal kind">${GOAL_KINDS.map((k) => opt(k, upper(k)))}</select></label>
        <label>WHO (optional) <select name="castId" data-fill="cast" data-optional="1" aria-label="Who"></select></label>
        <label>WHERE (optional) <select name="placeId" data-fill="place" data-optional="1" aria-label="Where"></select></label>
        <label>FROM DAY <input type="number" name="fromDay" min="0" max="13" step="1" value="0"></label>
        <label>TO DAY <input type="number" name="toDay" min="0" max="13" step="1" value="6"></label>
        <label>MINUTES (optional) <input type="number" name="minutes" min="15" max="240" step="5"></label>
        <label>LABEL (optional) <input type="text" name="label" maxlength="80"></label>
      </form>
      <button type="button" class="primary" id="ldGoalGo">PREVIEW GOAL</button>
      <div class="story-sub mono">OPEN GOALS</div>
      <div data-slot="ld-goals"></div>
    </div>
  </div>
</div>

<div class="col-2">
  <div class="panel" data-sec="controls">
    <div class="panel-head"><span>REWIND<button type="button" class="guide-q" data-guide="rewind" aria-label="Guide: rewind">?</button></span><span class="mono mute" data-slot="ld-rewind-window"></span></div>
    <div class="panel-body">
      <div class="story-form-row">
        <label>HOURS BACK <input type="number" id="ldRewindHours" min="1" max="720" step="1" value="24"></label>
        <label>REASON <input type="text" id="ldRewindReason" maxlength="200" placeholder="optional"></label>
        <button type="button" id="ldRewindAt">PREVIEW REWIND</button>
      </div>
      <div class="story-sub mono">OR PICK AN EVENT TO RETURN TO (THE WORLD AS IT WAS RIGHT AFTER IT)</div>
      <div class="story-scroll" data-slot="ld-events"></div>
    </div>
  </div>
  <div class="panel" data-sec="controls">
    <div class="panel-head"><span>BOOKMARKS<button type="button" class="guide-q" data-guide="bookmarks" aria-label="Guide: bookmarks">?</button></span><span class="mono mute">RESTORE = REWIND TO THE BOOKMARK</span></div>
    <div class="panel-body">
      <div class="story-form-row"><label>NAME <input type="text" id="ldBookmarkName" maxlength="60" placeholder="before the trip"></label><button type="button" id="ldBookmarkAdd">PREVIEW BOOKMARK NOW</button></div>
      <div data-slot="ld-bookmarks"></div>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:14px" data-panel="retcon" data-sec="build" data-wide>
  <div class="panel-head"><span>REWRITE THE PAST<button type="button" class="guide-q" data-guide="retcon" aria-label="Guide: rewrite the past">?</button></span><span class="mono mute">A REWIND + A CHANGE NOW · ONE PREVIEW, ONE APPLY</span></div>
  <div class="panel-body">
    <div class="story-note mono">Rewinds to the point you pick (everything after it is set aside, never deleted) and makes the change happen now. It cannot put events into the past: for a fact about his past, add a dated memory to a person instead (SCENE · CAST.HISTORY).</div>
    <div class="story-form-row">
      <label>BACK TO <select id="ldRetconTo" data-slot="ld-retcon-to" aria-label="Rewind target"><option value="">HOURS BACK →</option></select></label>
      <label>HOURS BACK <input type="number" id="ldRetconHours" min="1" max="720" step="1" value="24"></label>
      <label>REASON <input type="text" id="ldRetconReason" maxlength="200" placeholder="optional"></label>
    </div>
    <div class="story-form-row">
      <label>THEN, NOW <select id="ldRetconWhat" aria-label="The change">
        <option value="scene">THE SCENE FORM ABOVE</option><option value="weather">THE WEATHER FORM</option><option value="goal">THE GOAL FORM</option>
      </select></label>
      <button type="button" class="danger" id="ldRetconGo">PREVIEW REWRITE</button>
    </div>
  </div>
</div>

<div class="col-2">
  <div class="panel" data-sec="build">
    <div class="panel-head"><span>EDIT CAST · PLACES<button type="button" class="guide-q" data-guide="edit" aria-label="Guide: edit">?</button></span><span class="mono mute">RENAMES ARE NOT ALLOWED</span></div>
    <div class="panel-body">
      <form id="ldCastEdit" class="story-form" autocomplete="off">
        <label>WHO <select name="castId" data-fill="cast" aria-label="Cast member"></select></label>
        ${CAST_EDIT_FIELDS.map(([f, max]) => html`<label>${upper(f)} <input type="text" name="${f}" maxlength="${max}" placeholder="unchanged"></label>`)}
        <label>BIRTHDAY <input type="text" name="birthday" placeholder="YYYY-MM-DD" maxlength="10"></label>
      </form>
      <button type="button" id="ldCastEditGo">PREVIEW CAST EDIT</button>
      <form id="ldCastMetrics" class="story-form" autocomplete="off" style="margin-top:14px">
        <label>WHO <select name="castId" data-fill="cast" aria-label="Cast member for relationship numbers"></select></label>
        ${METRIC_FIELDS.map((f) => html`<label>${upper(f)} <input type="number" name="${f}" min="0" max="1" step="0.01" placeholder="unchanged"></label>`)}
      </form>
      <button type="button" id="ldCastMetricsGo">PREVIEW NUMBERS</button>
      <form id="ldPlaceEdit" class="story-form" autocomplete="off" style="margin-top:14px">
        <label>PLACE <select name="placeId" data-fill="place" aria-label="Place"></select></label>
        <label>NAME <input type="text" name="name" maxlength="60" placeholder="unchanged"></label>
        <label>KIND <input type="text" name="placeKind" maxlength="24" placeholder="unchanged"></label>
      </form>
      <button type="button" id="ldPlaceEditGo">PREVIEW PLACE EDIT</button>
    </div>
  </div>
  ${placesPanelShell}
  <div class="panel" data-sec="controls">
    <div class="panel-head"><span>SEED · RECONCILER · HEAVY<button type="button" class="guide-q" data-guide="seed" aria-label="Guide: seed">?</button></span><span class="mono mute">OVERRIDES ARE EVENTS · THE FILE IS NEVER WRITTEN</span></div>
    <div class="panel-body">
      <form id="ldSeed" class="story-form" autocomplete="off">
        <label>PATH <select name="path" aria-label="Seed path">${SEED_PATHS.map((p) => opt(p))}</select></label>
        <label>VALUE (JSON; null clears) <input type="text" name="value" maxlength="40" placeholder="e.g. 4 or [7,21]"></label>
      </form>
      <button type="button" id="ldSeedGo">PREVIEW SEED OVERRIDE</button>
      <div data-slot="ld-seed-missing"></div>
      <div class="story-form-row" style="margin-top:14px">
        <label>RECONCILER <select id="ldReconciler" aria-label="Reconciler mode">${RECONCILER_MODES.map((m) => opt(m, upper(m)))}</select></label>
        <button type="button" id="ldReconcilerGo">PREVIEW MODE</button>
      </div>
      <div class="story-form-row" style="margin-top:14px">
        <label>HEAVY ARC # <input type="number" id="ldHeavyId" min="1" step="1"></label>
        <button type="button" class="danger" id="ldHeavyEnd">PREVIEW END HEAVY ARC</button>
      </div>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:14px" data-sec="controls" data-wide>
  <div class="panel-head"><span>REFUSALS · WHAT THE CONTROLS STOPPED<button type="button" class="guide-q" data-guide="refusals" aria-label="Guide: refusals">?</button></span><span class="mono mute">LAST 50</span></div>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>WHEN</th><th>SOURCE</th><th>ACTION</th><th>TARGET</th><th>REASON</th></tr></thead>
    <tbody data-slot="ld-refusals"></tbody>
  </table></div>
</div>

</div>`;

// ── scene form ─────────────────────────────────────────────────────────────

function fieldHtml([name, type, o], lists) {
  const optional = (o && !Array.isArray(o) && o.optional) || (Array.isArray(o) && o[1] === true && type === 'text');
  const lab = `${upper(name)}${optional ? ' (optional)' : ''}`;
  switch (type) {
    case 'text': return html`<label>${lab} <input type="text" name="${name}" maxlength="${o[0]}"></label>`;
    case 'int': return html`<label>${lab} <input type="number" name="${name}" min="${o[0]}" max="${o[1]}" step="1" value="${o[2]}"></label>`;
    case 'float': return html`<label>${lab} <input type="number" name="${name}" min="${o[0]}" max="${o[1]}" step="0.1" value="1"></label>`;
    case 'select': return html`<label>${lab} <select name="${name}">${o.map((v) => opt(v, upper(v)))}</select></label>`;
    case 'cast': return html`<label>${lab} <select name="${name}">${optional ? opt('', '—') : ''}${lists.cast.map((c) => opt(c.id, c.name || c.id))}</select></label>`;
    case 'place': return html`<label>${lab} <select name="${name}">${lists.places.map((p) => opt(p.id, `${p.name || p.id}${p.kind ? ` · ${p.kind}` : ''}`))}</select></label>`;
    case 'casts': return html`<label>${lab} (≤ 4) <select name="${name}" multiple size="4">${lists.cast.map((c) => opt(c.id, c.name || c.id))}</select></label>`;
    case 'startIn': return html`<label>STARTS IN (MINUTES) <input type="number" name="${name}" min="0" max="${60 * 24 * 60}" step="5" value="60"></label>`;
    case 'daysAhead': return html`<label>${upper(name)} IN DAYS (optional) <input type="number" name="${name}" min="1" max="31" step="1"></label>`;
    case 'daysAgo': return html`<label>${upper(name)} DAYS AGO (optional) <input type="number" name="${name}" min="0" max="36500" step="1"></label>`;
    default: return null;
  }
}

/** Read a scene form into a scene action (structure only; the planner validates). */
export function sceneAction(shape, form) {
  const a = { kind: 'scene', shape };
  for (const [name, type] of SCENES[shape] || []) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (type === 'casts') {
      const ids = [...input.selectedOptions].map((o) => o.value).filter(Boolean).slice(0, 4);
      if (ids.length) a[name] = ids;
      continue;
    }
    const v = String(input.value ?? '').trim();
    if (v === '') continue;
    if (type === 'int') a[name] = Math.round(Number(v));
    else if (type === 'float') a[name] = Number(v);
    else if (type === 'startIn') a.startAt = nowSec() + Math.max(0, Math.round(Number(v))) * 60;
    else if (type === 'daysAhead') a[name] = nowSec() + Math.round(Number(v)) * 86400;
    else if (type === 'daysAgo') a[name] = nowSec() - Math.round(Number(v)) * 86400;
    else a[name] = v;
  }
  return a;
}

// ── panels ─────────────────────────────────────────────────────────────────

function controlsView(st, ro) {
  const fate = st.fate || {};
  const sliders = st.sliders || {};
  return html`
    <div class="story-sub mono">FATE PER CATEGORY · NATURAL = THE ENGINE DECIDES · GUIDED = ASK ME · FROZEN = NOTHING NEW</div>
    <div class="story-fate">${CATEGORIES.map((c) => html`<label class="story-fate-row"><span>${upper(c)}</span>
      <select class="ld-fate" data-category="${c}" aria-label="Fate for ${c}" ${dis(ro)}>${FATE_MODES.map((m) => opt(m, upper(m), (fate[c] || 'natural') === m))}</select></label>`)}</div>
    <div class="story-sub mono">SLIDERS · 0 … 1 · CHANGE = PREVIEW</div>
    ${SLIDERS.map((n) => html`<label class="story-slider"><span>${upper(n)}</span>
      <input type="range" class="ld-slider" data-name="${n}" min="0" max="1" step="0.05" value="${finite(sliders[n]) ? sliders[n] : 0.5}" aria-label="${n}" ${dis(ro)}>
      <b class="mono">${fx(finite(sliders[n]) ? sliders[n] : 0.5)}</b></label>`)}
    <div class="story-form-row" style="margin-top:12px">
      <label>REASON <input type="text" id="ldPauseReason" maxlength="200" placeholder="optional" ${dis(ro)}></label>
      ${st.paused
        ? html`<button type="button" class="primary" id="ldResume" ${dis(ro)}>PREVIEW RESUME STORY</button>`
        : html`<button type="button" class="danger" id="ldPause" ${dis(ro)}>PREVIEW PAUSE STORY</button>`}
    </div>`;
}

function pinsView(st, lists, ro) {
  const pins = Array.isArray(st.pins) ? st.pins : [];
  const suggestions = ['self.job', 'self.relationship', ...lists.cast.map((c) => c.id), ...lists.arcIds.map((id) => `arc:${id}.stage`)]
    .filter((k) => !pins.includes(k));
  return html`
    ${pins.length ? html`<div>${pins.map((k) => html`<span class="chip warn story-pin">${k} <button type="button" class="ld-unpin" data-key="${k}" aria-label="Unpin ${k}" ${dis(ro)}>×</button></span>`)}</div>`
      : html`<div class="empty">NOTHING PINNED</div>`}
    <div class="story-form-row"><label>PIN <select id="ldPinKey" aria-label="Pin key" ${dis(ro)}>${suggestions.map((k) => opt(k))}</select></label>
      <button type="button" id="ldPin" ${dis(ro)}>PREVIEW PIN</button></div>`;
}

function peopleOf(ex) {
  const p = Array.isArray(ex?.people) ? ex.people : [];
  return p.map((x) => (typeof x === 'string' ? x : x?.name)).filter((s) => typeof s === 'string' && s).slice(0, 4);
}

function trayView(rows, lists, ro, offset) {
  if (!rows.length) return html`<div class="empty">TRAY EMPTY</div>`;
  return html`${rows.map((r) => {
    const ex = r.extraction || {};
    const res = r.resolution || {};
    const people = peopleOf(ex);
    const when = ex.when ? [ex.when.relative, ex.when.weekday, ex.when.date, ex.when.time, ex.when.part].filter(Boolean).join(' ') : '';
    return html`<div class="story-tray" data-review="${r.id}">
      <div class="mono mute">#${r.id} · ${upper(r.status)} · ${r.reason ? html`<span class="chip warn">${upper(r.reason)}</span>` : ''} · ${r.chatName || r.chatJid || '—'} <span class="chip">${r.originKind || '?'}</span>
        · expires in <b data-countdown="${r.expiresAt ?? ''}">${countdownText(r.expiresAt, offset)}</b></div>
      <div class="life-claim-text">${r.text || html`<span class="mute">(claim text gone)</span>`}</div>
      ${ex.type ? html`<div class="mono story-extract">${upper(ex.type)}${ex.kind ? ` · ${ex.kind}` : ''}${when ? ` · ${when}` : ''}${ex.place ? ` · at ${ex.place}` : ''}${people.length ? ` · with ${people.join(', ')}` : ''}${finite(ex.minutes) ? ` · ${ex.minutes} min` : ''}</div>` : ''}
      ${r.conflict ? html`<div class="mono amber">CONFLICT · ${short(r.conflict)}</div>` : ''}
      <form class="story-form story-tray-map" autocomplete="off">
        ${people.map((name, i) => html`<label>${name} → <select name="map${i}" data-name="${name}" ${dis(ro)}>${opt('', '— unmapped —')}${lists.cast.map((c) => opt(c.id, c.name || c.id, (res.castIds || [])[i] === c.id))}</select></label>`)}
        <label>PLACE <select name="placeId" ${dis(ro)}>${opt('', '— as resolved —')}${lists.places.map((p) => opt(p.id, p.name || p.id, res.placeId === p.id))}</select></label>
        <label>STARTS IN (MIN, OPTIONAL) <input type="number" name="startIn" min="0" step="5" ${dis(ro)}></label>
        <label>MINUTES (OPTIONAL) <input type="number" name="minutes" min="15" max="360" step="5" ${dis(ro)}></label>
      </form>
      <div class="story-buttons">
        <button type="button" class="primary ld-adopt" data-id="${r.id}" ${dis(ro)}>PREVIEW ADOPT</button>
        <button type="button" class="ld-scene" data-id="${r.id}" ${dis(ro)}>OPEN AS SCENE</button>
        <button type="button" class="ld-reject" data-id="${r.id}" ${dis(ro)}>REJECT</button>
        <button type="button" class="ld-dismiss" data-id="${r.id}" ${dis(ro)}>DISMISS</button>
      </div>
    </div>`;
  })}`;
}

// ── advice from chats (012 P3; shared with the Story page) ─────────────────

let queuedPreset = null;

/** The Story page approved advice: the Director's scene form takes this preset when it mounts. */
export function queueScenePreset(preset) {
  queuedPreset = preset && typeof preset === 'object' ? { ...preset } : null;
}

/** Pending advice rows: the code-built summary, the live excerpt, APPROVE / REJECT (classes `${cls}-approve|reject`). */
export function adviceTable(rows, ro, cls) {
  if (!rows.length) return html`<div class="empty">NO SUGGESTIONS</div>`;
  return html`<div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>CATEGORY</th><th>WHAT</th><th>WHEN</th><th>EXPIRES IN</th><th></th></tr></thead><tbody>
    ${rows.map((a) => html`<tr>
      <td class="id">#${a.id}</td>
      <td><span class="chip">${upper(a.category)}</span></td>
      <td>${a.summary} <span class="chip">${a.originKind || '?'}</span>
        <div class="life-claim-text">${a.excerpt || html`<span class="mute">(the message is gone)</span>`}</div></td>
      <td class="mono">${a.createdAt ? `${fmtRelative(a.createdAt)} ago` : '—'}</td>
      <td class="mono"><b data-countdown="${a.expiresAt ?? ''}">${countdownText(a.expiresAt)}</b></td>
      <td><button type="button" class="primary ${cls}-approve" data-id="${a.id}" ${dis(ro)}>APPROVE</button>
        <button type="button" class="${cls}-reject" data-id="${a.id}" ${dis(ro)}>REJECT</button></td>
    </tr>`)}
  </tbody></table></div>`;
}

function bookmarksView(list, ro) {
  if (!list.length) return html`<div class="empty">NO BOOKMARKS</div>`;
  return html`<table class="data"><thead><tr><th>NAME</th><th>EVENT</th><th>WHEN</th><th></th></tr></thead><tbody>
    ${list.map((b) => html`<tr><td>${b.name}</td><td class="id">#${b.eventId}</td><td class="mono">${fmtTime(b.at)}</td>
      <td><button type="button" class="ld-restore" data-id="${b.id}" ${b.inWindow && !ro ? '' : 'disabled'} title="${b.inWindow ? '' : 'outside the rewind window'}">RESTORE</button>
        <button type="button" class="ld-bm-remove" data-id="${b.id}" ${dis(ro)}>REMOVE</button></td></tr>`)}
  </tbody></table>`;
}

function eventsView(events, ro) {
  if (!events.length) return html`<div class="empty">NO EVENTS</div>`;
  return html`<table class="data"><tbody>${events.map((e) => html`<tr class="${e.reverted ? 'is-reverted' : ''}">
    <td class="id">#${e.id}</td><td class="mono">${fmtHm(e.at)}</td><td>${e.type}</td><td><span class="chip">${e.actor}</span></td>
    <td><button type="button" class="ld-rewind-ev" data-id="${e.id}" ${dis(ro)}>REWIND HERE</button></td></tr>`)}</tbody></table>`;
}

function windowsView(list, ro) {
  if (!list.length) return html`<div class="empty">NO WINDOWS</div>`;
  return html`<table class="data"><tbody>${list.map((w) => html`<tr>
    <td class="id">#${w.id}</td><td><span class="chip">${upper(w.sky)}</span> <span class="mono mute">${fx(w.intensity)}</span></td>
    <td class="mono">${fmtTime(w.from)} → ${fmtTime(w.to)}</td>
    <td><button type="button" class="ld-w-end" data-id="${w.id}" ${dis(ro)}>END</button></td></tr>`)}</tbody></table>`;
}

function goalsView(list, lists, ro) {
  if (!list.length) return html`<div class="empty">NO GOALS</div>`;
  const castName = (id) => lists.cast.find((c) => c.id === id)?.name || id;
  const placeName = (id) => lists.places.find((p) => p.id === id)?.name || id;
  return html`<table class="data"><tbody>${list.map((g) => html`<tr>
    <td class="id">#${g.id}</td><td><span class="chip">${upper(g.goalKind)}</span>${g.castId ? ` ${castName(g.castId)}` : ''}${g.placeId ? ` · ${placeName(g.placeId)}` : ''}</td>
    <td class="mono">${fmtTime(g.from)} → ${fmtTime(g.to)}</td>
    <td>${g.status === 'planned' ? html`<span class="chip ok">PLANNED ${fmtHm(g.slotStart)}</span>` : g.lastReason ? html`<span class="chip warn">DEFERRED · ${g.lastReason}</span>` : html`<span class="chip">OPEN</span>`}</td>
    <td><button type="button" class="ld-g-cancel" data-id="${g.id}" ${dis(ro)}>CANCEL</button></td></tr>`)}</tbody></table>`;
}

/** The WEATHER form → a `weather` action (times from now, the server re-validates). */
export function weatherAction(form) {
  const v = (n) => form.elements.namedItem(n)?.value;
  const from = nowSec() + Math.max(0, Math.round(Number(v('fromHours')) * 3600) || 0);
  const hours = Math.min(72, Math.max(0.5, Number(v('hours')) || 3));
  return { kind: 'weather', weatherKind: v('weatherKind'), intensity: Math.round((Number(v('intensity')) || 0) * 100) / 100, from, to: from + Math.round(hours * 3600) };
}

/** The GOALS form → a `goal` action (whole days from today; the server resolves them). */
export function goalAction(form) {
  const v = (n) => form.elements.namedItem(n)?.value;
  const a = { kind: 'goal', goalKind: v('goalKind'), fromDay: Math.max(0, Math.round(Number(v('fromDay')) || 0)), toDay: Math.max(0, Math.round(Number(v('toDay')) || 0)) };
  if (v('castId')) a.castId = v('castId');
  if (v('placeId')) a.placeId = v('placeId');
  if (v('minutes')) a.minutes = Math.round(Number(v('minutes')));
  if (v('label')?.trim()) a.label = v('label').trim();
  return a;
}

function tomorrowView(t) {
  const rows = (Array.isArray(t?.planned) ? t.planned : []);
  return html`
    <div class="mono mute">${(t?.notes || []).join(' · ')} · ${fmtTime(t?.from)} → ${fmtTime(t?.to)}</div>
    <table class="data"><thead><tr><th>FROM</th><th>TO</th><th>WHAT</th><th>WHERE</th><th>AVAIL</th></tr></thead><tbody>
      ${rows.length ? rows.map((b) => html`<tr><td class="mono">${fmtHm(b.start)}</td><td class="mono">${fmtHm(b.end)}</td><td>${b.kind}</td><td>${b.place || b.placeId || '—'}</td><td>${b.availability || '—'}</td></tr>`)
        : html`<tr><td colspan="5" class="empty">NOTHING PLANNED</td></tr>`}
    </tbody></table>
    ${t?.decisions?.length ? html`<div class="story-sub mono">DECISIONS LIKELY TO OPEN</div><ul class="story-list">${t.decisions.map((d) => html`<li>${upper(d.category)} · ${d.kind}${d.big ? html` <span class="chip warn">BIG</span>` : ''} · opens ${fmtHm(d.opensAt)} · decide by ${fmtHm(d.decideBy)}${d.leanFromCosts ? ` · leans ${d.leanFromCosts.optionId} (${fx(d.leanFromCosts.p)})` : ''}</li>`)}</ul>` : ''}
    ${t?.birthdays?.length ? html`<div class="story-sub mono">BIRTHDAYS</div><ul class="story-list">${t.birthdays.map((b) => html`<li>${b.castId || 'self'} · ${fmtTime(b.at)}</li>`)}</ul>` : ''}
    ${t?.beats?.length ? html`<div class="story-sub mono">DAILY BEATS</div><ul class="story-list">${t.beats.map((b) => html`<li>${b.type}${b.castId ? ` · ${b.castId}` : ''} · ${fmtHm(b.at)}</li>`)}</ul>` : ''}
    ${t?.heavy ? html`<div class="red mono">HEAVY ONSET DUE · ${t.heavy.kind} · ${fmtTime(t.heavy.onsetAt)}</div>` : ''}
    ${t?.weather?.length ? html`<div class="story-sub mono">WEATHER</div><ul class="story-list">${t.weather.map((w) => html`<li>${fmtHm(w.at)} · ${String(w.condition || '').replace(/_/g, ' ')}${finite(w.tempC) ? ` · ${w.tempC}°` : ''}${w.owner ? html` <span class="chip warn">SET BY YOU</span>` : ''}</li>`)}</ul>` : ''}
    ${t?.goals?.length ? html`<div class="story-sub mono">GOALS</div><ul class="story-list">${t.goals.map((g) => html`<li>#${g.id} · ${upper(g.goalKind)} · ${g.status === 'fitted' || g.status === 'done' ? `${g.status === 'done' ? 'done' : 'planned'}${g.slotStart ? ` ${fmtHm(g.slotStart)}` : ''}` : g.lastReason ? `not fitted (${g.lastReason})` : 'not fitted'}</li>`)}</ul>` : ''}`;
}

// ── tell the story (spec 011; the panel itself: pages/life-director-story.js, 017) ──

// Draft kinds EDIT can load into a form below (a draft that creates a person or a
// place, or picked a real venue, has no form for that part).
const EDITABLE = new Set(['scene', 'cast.edit', 'cast.metrics', 'place.edit', 'seed.set', 'weather', 'goal']);
export const editableDraft = (d) => EDITABLE.has(d?.action?.kind) && !d.action?.newCast && !d.action?.newPlace && !d.action?.candidateId && !d.status;
// The step-by-step panel's helpers, here too for the tests and the other story pages.
export { sideLock, DROP_REASONS, REVIEW_REASONS } from './life-director-story.js';

// ── mount ──────────────────────────────────────────────────────────────────

export async function mount(ctx, linked) {
  const root = ctx.root;
  render(root, SHELL);
  const paintSlot = slotPainter(root);
  const section = sectionStrip(root, linked, paintSlot);
  ctx.listen(root, 'click', (e) => {
    const seg = e.target.closest?.('[data-seg]');
    if (seg && root.querySelector('[data-slot="ld-seg"]')?.contains(seg)) section.choose(seg.dataset.seg);
  });
  const lists = { cast: [], places: [], arcIds: [], heavyIds: [] };
  let st = {};
  let offset = 0;
  const ro = () => readOnly() || !st.enabled;

  const preview = (action, title) => openPreview(ctx, action, { title, onApplied: () => load().catch(() => {}) });
  // 014 geo: PLACES (its own block; ids only reach the server).
  const placesPanel = mountPlacesPanel(ctx, root, {
    openPreview, ro: () => ro(), places: () => lists.places, reload: () => load().catch(() => {}),
  });
  // 015: PLAY GOD (its own module; reloads with the page).
  const god = mountGodPanel(ctx, root.querySelector('[data-slot="ld-god"]'), {
    openPreview: (action, title) => openPreview(ctx, action, { title }), readOnly: () => ro(), onChanged: () => load().catch(() => {}),
  });

  // Tell the story (017): the step-by-step panel; the usage line comes from the arcs status.
  function promptMeta() {
    const b = st.budgets || {};
    return `ONE MIND CALL · TODAY ${b.promptToday ?? '—'} OF ${b.promptDayCap ?? '—'} · THIS MONTH ${fx(b.promptMonthUsd)} OF ${fx(b.promptCapUsd)} USD`;
  }
  const story = mountStoryPanel(ctx, root, {
    ro, places: () => lists.places, meta: promptMeta, onApplied: () => load().catch(() => {}),
    openPreview: (action, o) => openPreview(ctx, action, o), editCard: (c) => editCard(c), editable: editableDraft,
  });

  function fillSelects() {
    for (const sel of root.querySelectorAll('select[data-fill]')) {
      if (sel === document.activeElement) continue;   // an open picker stays open through a poll
      const keep = sel.value;
      const items = sel.dataset.fill === 'cast' ? lists.cast.map((c) => [c.id, c.name || c.id]) : lists.places.map((p) => [p.id, p.name || p.id]);
      render(sel, [...(sel.dataset.optional ? [opt('', '—', keep === '')] : []), ...items.map(([v, l]) => opt(v, l, v === keep))]);
    }
    metricPlaceholders();
  }

  // The NUMBERS form shows the chosen member's current values as placeholders.
  function metricPlaceholders() {
    const f = $(root, '#ldCastMetrics');
    if (!f) return;
    const m = lists.cast.find((c) => c.id === f.elements.namedItem('castId').value)?.metrics || {};
    for (const k of METRIC_FIELDS) f.elements.namedItem(k).placeholder = finite(m[k]) ? `now ${fx(m[k])}` : 'unchanged';
  }

  function renderSceneForm() {
    const shape = $(root, '#ldShape')?.value || 'outing';
    render($(root, '#ldScene'), (SCENES[shape] || []).map((f) => fieldHtml(f, lists)));
  }

  function setDisabled() {
    const off = ro();
    for (const n of root.querySelectorAll('#ldScenePreview, #ldWeatherGo, #ldGoalGo, #ldTomorrow, #ldRewindAt, #ldBookmarkAdd, #ldCastEditGo, #ldPlaceEditGo, #ldSeedGo, #ldReconcilerGo, #ldHeavyEnd, .story-buttons[data-slot="ld-quick"] button')) n.disabled = off;
    const rc = $(root, '#ldRetconGo');   // 015 cont
    if (rc) rc.disabled = off;
  }

  async function load() {
    st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    const get = (url, fb) => api(url, { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return fb; });
    god.load().catch(() => {});   // 015
    const [cast, board, map, bms, tray, returned, refusals, events, advice] = await Promise.all([
      get('/api/arcs/cast', { cast: [] }),
      get('/api/arcs/story', { categories: [] }),
      get('/api/life/map', { places: [] }),
      get('/api/director/bookmarks', { bookmarks: [] }),
      get('/api/arcs/claims?status=tray&limit=50', { claims: [] }),
      get('/api/arcs/claims?status=returned&limit=50', { claims: [] }),
      get('/api/arcs/refusals?limit=50', { refusals: [] }),
      get('/api/life/events?limit=40', { events: [] }),
      get('/api/influence/advice?status=pending&limit=50', { advice: [] }),
    ]);
    if (!ctx.alive()) return;
    lists.cast = Array.isArray(cast?.cast) ? cast.cast : [];
    lists.places = Array.isArray(map?.places) ? map.places : [];
    const cats = Array.isArray(board?.categories) ? board.categories : [];
    lists.arcIds = cats.flatMap((c) => (Array.isArray(c.arcs) ? c.arcs : []).map((a) => a.id)).filter((id) => id != null);
    lists.heavyIds = (cats.find((c) => c.category === 'heavy')?.arcs || []).map((a) => a.id).filter((id) => id != null);
    const isRo = ro();

    paintSlot('ld-off', arcsOffNote(st));
    paintSlot('ld-ro', readOnly()
      ? html`<div class="panel life-off"><div class="panel-body"><b class="amber">READ-ONLY</b> <span class="mute">Previews rebuild projections and can show claim text, so they need write mode like any write (DASHBOARD_READONLY=false + CSRF).</span></div></div>`
      : null);
    setSlots(root, {
      'ld-paused': st.paused ? 'PAUSED' : st.enabled ? 'RUNNING' : 'OFF',
      'ld-mode': upper(st.reconcilerMode),
      'ld-seed': st.seed?.source ? upper(st.seed.source) : '—',
      'ld-tray': st.counts?.tray ?? 0,
      'ld-ref24': st.counts?.refusals24h ?? 0,
      'ld-budget': st.budgets ? `MIND ${fx(st.budgets.mindMonthUsd)} / ${fx(st.budgets.mindCapUsd)} USD · CLERK ${st.budgets.clerkToday ?? '—'}/${st.budgets.clerkCap ?? '—'}` : '',
      'ld-rewind-window': 'WITHIN THE REWIND WINDOW · NOTHING IS DELETED',
    });
    section.setWaiting((st.counts?.tray ?? 0) + (Array.isArray(advice?.advice) ? advice.advice.length : 0));
    story.refresh();
    paintSlot('ld-quick', QUICK.map(([b, label]) => html`<button type="button" class="ld-quick" data-button="${b}" ${dis(isRo)}>${label}</button>`));
    const controls = root.querySelector('[data-panel="controls"]');
    if (!controls?.contains(document.activeElement)) setSlot(root, 'ld-controls', controlsView(st, isRo));   // always: a cancelled slider or mode preview snaps back
    const pinsEl = root.querySelector('[data-slot="ld-pins"]');
    if (!pinsEl?.contains(document.activeElement)) setSlot(root, 'ld-pins', pinsView(st, lists, isRo));
    const trayRows = [...(tray?.claims || []), ...(returned?.claims || [])];
    offset = 0;
    const trayEl = root.querySelector('[data-slot="ld-tray-rows"]');
    if (!trayEl?.contains(document.activeElement)) paintSlot('ld-tray-rows', trayView(trayRows, lists, isRo, offset));
    const adviceEl = root.querySelector('[data-slot="ld-advice-rows"]');
    if (!adviceEl?.contains(document.activeElement)) paintSlot('ld-advice-rows', adviceTable(Array.isArray(advice?.advice) ? advice.advice : [], isRo, 'ld-advice'));
    paintSlot('ld-bookmarks', bookmarksView(Array.isArray(bms?.bookmarks) ? bms.bookmarks : [], isRo));
    retconTargets(Array.isArray(bms?.bookmarks) ? bms.bookmarks : []);   // 015 cont
    paintSlot('ld-windows', windowsView(Array.isArray(st.windows) ? st.windows : [], isRo));
    paintSlot('ld-goals', goalsView(Array.isArray(st.goals) ? st.goals : [], lists, isRo));
    paintSlot('ld-events', eventsView(Array.isArray(events?.events) ? events.events : [], isRo));
    const refs = Array.isArray(refusals?.refusals) ? refusals.refusals : [];
    paintSlot('ld-refusals', refs.length
      ? refs.map((r) => html`<tr><td class="mono">${r.at || r.createdAt ? `${fmtRelative(r.at || r.createdAt)} ago` : '—'}</td><td>${r.source}</td><td>${r.action}</td><td class="mono">${r.target || '—'}</td><td><span class="chip">${r.reason}</span>${r.pinKey ? html` <span class="mono mute">pin ${r.pinKey}</span>` : ''}</td></tr>`)
      : html`<tr><td colspan="5" class="empty">NO REFUSALS</td></tr>`);
    const missing = Array.isArray(st.seed?.missing) ? st.seed.missing : [];
    paintSlot('ld-seed-missing', missing.length ? html`<div class="mono amber">SEED SECTIONS MISSING (THOSE ARCS STAY INERT): ${missing.join(', ')}</div>` : null);
    const rec = $(root, '#ldReconciler');
    if (rec && document.activeElement !== rec && st.reconcilerMode) rec.value = st.reconcilerMode;
    const hv = $(root, '#ldHeavyId');
    if (hv && !hv.value && lists.heavyIds.length) hv.value = String(lists.heavyIds[0]);
    fillSelects();
    const scene = $(root, '#ldScene');
    if (scene && !scene.children.length) renderSceneForm();
    setDisabled();
    await placesPanel.refresh();   // 014 geo
    schedulePanel?.refresh();   // 014 sched
  }

  // ── events ──
  const resetScene = () => { delete $(root, '#ldScene').dataset.fromReviewId; renderSceneForm(); };
  // Load a draft scene into the SCENE form (structure only: ids, numbers, the draft's own short texts).
  function fillSceneForm(d) {
    const shape = SCENES[d.shape] ? d.shape : 'outing';
    $(root, '#ldShape').value = shape;
    resetScene();
    const f = $(root, '#ldScene');
    const set = (name, v) => { const el2 = f.elements.namedItem(name); if (el2 && v !== undefined && v !== null) el2.value = String(v); };
    for (const k of ['placeId', 'castId', 'beatKind', 'text', 'minutes', 'label', 'name', 'relation', 'pronouns', 'personality', 'status',
      'metVia', 'placeKind', 'near', 'offsetKm', 'category', 'arcKind', 'arcId', 'to']) set(k, d[k]);
    const casts = f.elements.namedItem('castIds');
    if (casts && Array.isArray(d.castIds)) for (const o of casts.options) o.selected = d.castIds.includes(o.value);
    if (finite(d.startAt)) set('startIn', Math.max(0, Math.round((d.startAt - nowSec()) / 60)));
    set('until', d.untilDays);
    set('dated', d.daysAgo);
    section.reveal(f);
  }
  function editCard(c) {
    const a = c.draft.action;
    if (a.kind === 'scene') {
      // The draft's time: in N minutes, or the resolved start of its preview.
      const ev = (c.preview?.events || []).find((e) => e.type === 'decision.opened');
      const startAt = finite(a.when?.inMinutes) ? nowSec() + a.when.inMinutes * 60 : ev?.payload?.subject?.eventAt;
      fillSceneForm({ ...a, startAt });
    } else if (a.kind === 'cast.edit') {
      const f = $(root, '#ldCastEdit');
      f.reset();
      f.elements.namedItem('castId').value = a.castId;
      for (const [k, v] of Object.entries(a.fields || {})) if (f.elements.namedItem(k)) f.elements.namedItem(k).value = String(v);
      section.reveal(f);
    } else if (a.kind === 'cast.metrics') {
      const f = $(root, '#ldCastMetrics');
      f.reset();
      f.elements.namedItem('castId').value = a.castId;
      metricPlaceholders();
      for (const k of METRIC_FIELDS) if (finite(a[k])) f.elements.namedItem(k).value = String(a[k]);
      section.reveal(f);
    } else if (a.kind === 'place.edit') {
      const f = $(root, '#ldPlaceEdit');
      f.reset();
      f.elements.namedItem('placeId').value = a.placeId;
      if (a.name) f.elements.namedItem('name').value = a.name;
      if (a.placeKind) f.elements.namedItem('placeKind').value = a.placeKind;
      section.reveal(f);
    } else if (a.kind === 'weather') {
      // The draft's window as resolved by its preview (or now), back into hours from now.
      const set = (c.preview?.events || []).find((e) => e.type === 'weather.window_set')?.payload;
      const f = $(root, '#ldWeather');
      f.elements.namedItem('weatherKind').value = a.weatherKind;
      if (finite(a.intensity)) f.elements.namedItem('intensity').value = String(a.intensity);
      if (set) {
        f.elements.namedItem('fromHours').value = String(Math.max(0, Math.round((set.from - nowSec()) / 3600)));
        f.elements.namedItem('hours').value = String(Math.max(0.5, Math.round(((set.to - set.from) / 3600) * 2) / 2));
      }
      section.reveal(f);
    } else if (a.kind === 'goal') {
      const f = $(root, '#ldGoal');
      f.reset();
      fillSelects();
      // Its window as resolved by the preview (day starts in the bot's time zone), back into days from today.
      const set = (c.preview?.events || []).find((e) => e.type === 'goal.set')?.payload;
      f.elements.namedItem('goalKind').value = a.goalKind;
      f.elements.namedItem('castId').value = a.castId || '';
      f.elements.namedItem('placeId').value = a.placeId || '';
      if (set) {
        f.elements.namedItem('fromDay').value = String(Math.max(0, Math.ceil((set.from - nowSec()) / 86400)));
        f.elements.namedItem('toDay').value = String(Math.max(0, Math.ceil((set.to - nowSec()) / 86400) - 1));
      }
      if (finite(a.minutes)) f.elements.namedItem('minutes').value = String(a.minutes);
      if (a.label) f.elements.namedItem('label').value = a.label;
      section.reveal(f);
    } else if (a.kind === 'seed.set') {
      const f = $(root, '#ldSeed');
      f.elements.namedItem('path').value = a.path;
      f.elements.namedItem('value').value = JSON.stringify(a.value);
      section.reveal(f);
    }
    flash('DRAFT LOADED INTO THE FORM · CHECK IT AND PREVIEW');
  }
  // Approved advice → the scene form, set to an arc.start in its category (the owner previews and applies, or not).
  function applyScenePreset(p) {
    if (!p || !SCENES[p.shape]) return;
    $(root, '#ldShape').value = p.shape;
    resetScene();
    const f = $(root, '#ldScene');
    const cat = f.elements.namedItem('category');
    if (cat && ARC_KINDS[p.category]) {
      cat.value = p.category;
      const kind = f.elements.namedItem('arcKind');
      if (kind) kind.value = ARC_KINDS[p.category][0];
    }
    flash(`SCENE PRESET · ${upper(p.category)} · PICK WHO AND PREVIEW`);
    section.reveal(f);
  }
  ctx.listen($(root, '#ldShape'), 'change', resetScene);
  ctx.listen($(root, '#ldScenePreview'), 'click', () => {
    const shape = $(root, '#ldShape').value;
    const form = $(root, '#ldScene');
    const action = sceneAction(shape, form);
    // A scene drafted from a claim carries its review id (structured ids only, never claim text).
    const fromReviewId = Number(form.dataset.fromReviewId);
    if (Number.isSafeInteger(fromReviewId) && fromReviewId > 0) action.fromReviewId = fromReviewId;
    preview(action, `SCENE · ${upper(shape)}${action.fromReviewId ? ` · FROM REVIEW #${action.fromReviewId}` : ''}`).then((r) => { if (r.applied) resetScene(); });
  });
  ctx.listen($(root, '#ldWeatherGo'), 'click', () => {
    const a = weatherAction($(root, '#ldWeather'));
    preview(a, `WEATHER · ${upper(a.weatherKind)}`);
  });
  ctx.listen($(root, '#ldGoalGo'), 'click', () => {
    const a = goalAction($(root, '#ldGoal'));
    preview(a, `GOAL · ${upper(a.goalKind)}`).then((r) => { if (r.applied) $(root, '#ldGoal').reset(); });
  });
  ctx.listen($(root, '#ldTomorrow'), 'click', async (e) => {
    e.target.disabled = true;
    setSlot(root, 'ld-tomorrow', html`<div class="loading">SIMULATING</div>`);
    try {
      const t = await api('/api/director/preview-tomorrow', { method: 'POST', body: {} });
      if (ctx.alive()) setSlot(root, 'ld-tomorrow', tomorrowView(t));
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) setSlot(root, 'ld-tomorrow', html`<div class="red mono">${err.message}</div>`);
    } finally {
      if (ctx.alive()) e.target.disabled = ro();
    }
  });
  const reason = (sel) => String($(root, sel)?.value || '').trim() || undefined;
  ctx.listen($(root, '#ldRewindAt'), 'click', () => {
    const h = Math.round(Number($(root, '#ldRewindHours').value));
    if (!Number.isFinite(h) || h < 1) { flash('HOURS BACK MUST BE ≥ 1', 'bad'); return; }
    preview({ kind: 'rewind', at: nowSec() - h * 3600, reason: reason('#ldRewindReason') }, `REWIND ${h} H`);
  });
  // 015 cont: REWRITE THE PAST — rewind to a bookmark (or hours back) + the chosen form's change, dated now.
  function retconTargets(bookmarks) {
    const sel = $(root, '#ldRetconTo');
    if (!sel) return;
    const keep = sel.value;
    render(sel, [opt('', 'HOURS BACK →', keep === ''), ...bookmarks.filter((b) => b.inWindow).map((b) => opt(String(b.id), `${b.name} · ${b.at ? fmtTime(b.at) : '—'}`, String(b.id) === keep))]);
  }
  ctx.listen($(root, '#ldRetconGo'), 'click', () => {
    const what = $(root, '#ldRetconWhat').value;
    let change;
    if (what === 'weather') change = weatherAction($(root, '#ldWeather'));
    else if (what === 'goal') change = goalAction($(root, '#ldGoal'));
    else change = sceneAction($(root, '#ldShape').value, $(root, '#ldScene'));
    if (change.kind === 'scene' && change.shape === 'heavy') { flash('HARD STRETCHES STAY ON THEIR OWN (SCENE · HEAVY)', 'bad'); return; }
    const bm = Number($(root, '#ldRetconTo').value);
    let to;
    if (Number.isSafeInteger(bm) && bm > 0) to = { bookmarkId: bm };
    else {
      const h = Math.round(Number($(root, '#ldRetconHours').value));
      if (!Number.isFinite(h) || h < 1) { flash('HOURS BACK MUST BE ≥ 1', 'bad'); return; }
      to = { at: nowSec() - h * 3600 };
    }
    const r = reason('#ldRetconReason');
    preview({ kind: 'retcon', to, actions: [change], ...(r ? { reason: r } : {}) }, `REWRITE · ${to.bookmarkId ? 'TO A BOOKMARK' : 'BACK'} · ${upper(change.kind === 'scene' ? change.shape : change.kind)}`);
  });
  ctx.listen($(root, '#ldBookmarkAdd'), 'click', () => {
    const name = String($(root, '#ldBookmarkName').value || '').trim();
    if (!name) { flash('NAME THE BOOKMARK', 'bad'); return; }
    preview({ kind: 'bookmark', name }, 'BOOKMARK').then((r) => { if (r.applied) $(root, '#ldBookmarkName').value = ''; });
  });
  ctx.listen($(root, '#ldCastEditGo'), 'click', () => {
    const f = $(root, '#ldCastEdit');
    const fields = {};
    for (const [k] of [...CAST_EDIT_FIELDS, ['birthday']]) {
      const v = String(f.elements.namedItem(k)?.value || '').trim();
      if (v) fields[k] = v;
    }
    if (!Object.keys(fields).length) { flash('CHANGE AT LEAST ONE FIELD', 'bad'); return; }
    preview({ kind: 'cast.edit', castId: f.elements.namedItem('castId').value, fields }, 'CAST EDIT').then((r) => { if (r.applied) f.reset(); });
  });
  ctx.listen($(root, '#ldCastMetricsGo'), 'click', () => {
    const f = $(root, '#ldCastMetrics');
    const a = { kind: 'cast.metrics', castId: f.elements.namedItem('castId').value };
    for (const k of METRIC_FIELDS) {
      const raw = String(f.elements.namedItem(k).value || '').trim();
      if (!raw) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 1) { flash(`${upper(k)} MUST BE 0 – 1`, 'bad'); return; }
      a[k] = Math.round(v * 100) / 100;
    }
    if (!METRIC_FIELDS.some((k) => a[k] !== undefined)) { flash('SET AT LEAST ONE NUMBER', 'bad'); return; }
    preview(a, 'RELATIONSHIP NUMBERS').then((r) => { if (r.applied) { f.reset(); load().catch(() => {}); } });
  });
  ctx.listen($(root, '#ldCastMetrics').elements.namedItem('castId'), 'change', metricPlaceholders);
  ctx.listen($(root, '#ldPlaceEditGo'), 'click', () => {
    const f = $(root, '#ldPlaceEdit');
    const a = { kind: 'place.edit', placeId: f.elements.namedItem('placeId').value };
    const name = String(f.elements.namedItem('name').value || '').trim();
    const kind = String(f.elements.namedItem('placeKind').value || '').trim();
    if (name) a.name = name;
    if (kind) a.placeKind = kind;
    if (!name && !kind) { flash('CHANGE THE NAME OR THE KIND', 'bad'); return; }
    preview(a, 'PLACE EDIT').then((r) => { if (r.applied) f.reset(); });
  });
  ctx.listen($(root, '#ldSeedGo'), 'click', () => {
    const f = $(root, '#ldSeed');
    let value;
    try { value = JSON.parse(String(f.elements.namedItem('value').value || '').trim()); } catch { flash('VALUE MUST BE JSON (a number, [a,b] or null)', 'bad'); return; }
    preview({ kind: 'seed.set', path: f.elements.namedItem('path').value, value }, 'SEED OVERRIDE');
  });
  ctx.listen($(root, '#ldReconcilerGo'), 'click', () => preview({ kind: 'reconciler.mode', mode: $(root, '#ldReconciler').value }, 'RECONCILER MODE'));
  ctx.listen($(root, '#ldHeavyEnd'), 'click', () => {
    const id = Math.round(Number($(root, '#ldHeavyId').value));
    if (!Number.isSafeInteger(id) || id < 1) { flash('WHICH HEAVY ARC? (its id)', 'bad'); return; }
    preview({ kind: 'heavy.end', heavyId: id }, 'END HEAVY ARC');
  });

  async function direct(path, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await api(path, { method: 'POST', body: {} });
      flash(okMsg);
      if (ctx.alive()) await load();
      return res;
    } catch (err) {
      if (!isAbort(err)) flash(err.message, 'bad');
      if (btn && ctx.alive()) btn.disabled = false;
      return null;
    }
  }

  ctx.listen(root, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('ld-quick')) { preview({ kind: 'quick', button: t.dataset.button }, `QUICK · ${t.textContent}`); return; }
    if (t.id === 'ldPause' || t.id === 'ldResume') { preview({ kind: t.id === 'ldPause' ? 'pause' : 'resume', reason: reason('#ldPauseReason') }, t.id === 'ldPause' ? 'PAUSE STORY' : 'RESUME STORY'); return; }
    if (t.id === 'ldPin') { const k = $(root, '#ldPinKey')?.value; if (k) preview({ kind: 'pin', pinKey: k }, `PIN ${k}`); return; }
    if (t.classList.contains('ld-unpin')) { preview({ kind: 'unpin', pinKey: t.dataset.key }, `UNPIN ${t.dataset.key}`); return; }
    if (t.classList.contains('ld-restore')) { preview({ kind: 'rewind', bookmarkId: Number(t.dataset.id) }, 'RESTORE BOOKMARK'); return; }
    if (t.classList.contains('ld-w-end')) { preview({ kind: 'weather.end', windowId: Number(t.dataset.id) }, `END WEATHER WINDOW #${t.dataset.id}`); return; }
    if (t.classList.contains('ld-g-cancel')) { preview({ kind: 'goal.cancel', goalId: Number(t.dataset.id) }, `CANCEL GOAL #${t.dataset.id}`); return; }
    if (t.classList.contains('ld-bm-remove')) { preview({ kind: 'bookmark.remove', bookmarkId: Number(t.dataset.id) }, 'REMOVE BOOKMARK'); return; }
    if (t.classList.contains('ld-rewind-ev')) { preview({ kind: 'rewind', toEventId: Number(t.dataset.id), reason: reason('#ldRewindReason') }, `REWIND TO #${t.dataset.id}`); return; }
    const id = t.dataset.id;
    if (t.classList.contains('ld-advice-reject')) { direct(`/api/influence/advice/${encodeURIComponent(id)}/reject`, `SUGGESTION ${id} REJECTED`, t); return; }
    if (t.classList.contains('ld-advice-approve')) {
      const r = await direct(`/api/influence/advice/${encodeURIComponent(id)}/approve`, `SUGGESTION ${id} APPROVED`, t);
      if (r?.preset && ctx.alive()) applyScenePreset(r.preset);
      return;
    }
    if (t.classList.contains('ld-reject')) {
      const { ok } = await askSheet({ label: `Reject review #${id}`, text: 'This claim will never be adopted into his world.', action: 'REJECT', danger: true });
      if (ok && ctx.alive()) direct(`/api/arcs/claims/${encodeURIComponent(id)}/reject`, `REVIEW ${id} REJECTED`, t);
      return;
    }
    if (t.classList.contains('ld-dismiss')) { direct(`/api/arcs/claims/${encodeURIComponent(id)}/dismiss`, `REVIEW ${id} DISMISSED`, t); return; }
    if (t.classList.contains('ld-adopt')) {
      const box = t.closest('.story-tray');
      const form = $(box, 'form');
      const castMap = {};
      for (const sel of form.querySelectorAll('select[data-name]')) if (sel.value) castMap[sel.dataset.name] = sel.value;
      const a = { kind: 'tray.adopt', reviewId: Number(id), castMap };
      const placeId = form.elements.namedItem('placeId')?.value;
      if (placeId) a.placeId = placeId;
      const startIn = String(form.elements.namedItem('startIn')?.value || '').trim();
      if (startIn) a.startAt = nowSec() + Math.round(Number(startIn)) * 60;
      const minutes = String(form.elements.namedItem('minutes')?.value || '').trim();
      if (minutes) a.minutes = Math.round(Number(minutes));
      preview(a, `ADOPT CLAIM #${id}`);
      return;
    }
    if (t.classList.contains('ld-scene')) {
      t.disabled = true;
      try {
        const r = await api(`/api/arcs/claims/${encodeURIComponent(id)}/scene`, { method: 'POST', body: {} });
        const d = r?.draft || {};
        if (!ctx.alive()) return;
        fillSceneForm({ shape: d.shape, placeId: d.placeId, castIds: d.castIds, startAt: d.startAt, minutes: d.minutes });
        $(root, '#ldScene').dataset.fromReviewId = String(d.fromReviewId ?? id);
        flash(`SCENE DRAFTED FROM REVIEW ${id} · CHECK IT AND PREVIEW`);
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
      } finally {
        if (ctx.alive()) t.disabled = ro();
      }
    }
  });
  ctx.listen(root, 'change', (e) => {
    const t = e.target;
    if (t.classList?.contains('ld-fate')) {
      preview({ kind: 'fate', category: t.dataset.category, mode: t.value }, `FATE · ${upper(t.dataset.category)} → ${upper(t.value)}`).then(() => load().catch(() => {}));
    } else if (t.classList?.contains('ld-slider')) {
      const v = Math.round(Number(t.value) * 100) / 100;
      const out = t.parentElement?.querySelector('b');
      if (out) out.textContent = fx(v);
      preview({ kind: 'slider', name: t.dataset.name, value: v }, `SLIDER · ${upper(t.dataset.name)} → ${fx(v)}`).then(() => load().catch(() => {}));
    }
  });

  // 014 sched: the SCHEDULE panel (its place / cast selects are filled by fillSelects).
  const schedulePanel = mountSchedulePanel(ctx, root, {
    lists, ro, onApplied: () => load().catch(() => {}), prompt: story.prompt, renderPrompt: story.renderPrompt, previewCard: story.previewCard,
    openPreview: (action, title) => openPreview(ctx, action, { title }),   // 015: the continuity review applies
  });
  // Blocks that bring their own shell join their section here.
  root.querySelector('[data-host="schedule"]')?.setAttribute('data-sec', 'day');
  root.querySelector('[data-panel="places"]')?.setAttribute('data-sec', 'build');
  const tell = root.querySelector('[data-panel="prompt"]');
  tell?.setAttribute('data-sec', 'tell');
  tell?.setAttribute('data-wide', '');

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  if (queuedPreset) {
    const p = queuedPreset;
    queuedPreset = null;
    applyScenePreset(p);
  }
  ctx.setInterval(() => tickCountdowns(root, offset), 1000);
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life director poll', err); }); }, POLL_MS);
}
