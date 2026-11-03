// LIFE · DIRECTOR · PLAY GOD (spec 015 P1, plan §P1.10) — the opened owner
// powers, mounted by pages/life-director.js under TELL THE STORY:
//
//   OUTCOMES   his upcoming decisions, a plan made in a chat included (marked; a real
//              person's takes only a pick or a cancel): PICK an option
//              for him, or set how it TURNS OUT (well / badly / cancelled); for an
//              outing, a TONE HINT for its scene (016: "they hit it off"…, ≤ 120
//              chars, used when the scene is written; TONE alone or with SET)
//   CAREER     hire / fire / quit / promote / a new job / salary / office pattern,
//              now or from a later time
//   MONEY      set his balance, a one-off income or expense
//   HOME       move him near a place he knows, or into a neighbourhood found by
//              an AREA search (POST /api/places/search {areas:true}; the geo
//              lookup, owner click only), now or later; the flatmate stays,
//              leaves or comes along
//   MOOD       how he feels when he wakes on a day, or at a later time; HEALTH:
//              ill now / later for N days, or well again
//   PEOPLE     write someone out of his life (moved away / out / written out) or
//              bring them back; every relationship number incl. the romance ones
//   PENDING    scheduled changes not yet due, with REVERT
//   CHANGES    the recent Director changes, each in words (the server's code-
//              built description: what it set, when, what it cancelled) with
//              REVERT THIS CHANGE: one action that undoes everything that change
//              did (previewed first; the confirm repeats the description)
//
// Every form builds an ordinary Director action and opens the shared preview
// modal (openPreview): nothing changes until APPLY. A hand-built action plans
// with the owner's relaxations — pacing limits and his own pins / freezes come
// back as WARNINGS, never refusals; hard limits (privacy, content safety, size
// caps) still refuse. Reads GET /api/director/god; strings reach the DOM
// through html`` only; times through core/fmt (the bot's time zone).
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, $ } from '../core/dom.js';
import { fmtTime, fmtRelative, getTimezone } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { upper, fx, finite } from './life-cast.js';
import { TONE_CHIPS, TONE_MAX, TONE_OUTCOME, OUTCOME_WORDS } from '../components/scene-panel.js';

const TABS = [['outcomes', 'OUTCOMES'], ['career', 'CAREER'], ['money', 'MONEY'], ['home', 'HOME'], ['mood', 'MOOD & HEALTH'],
  ['people', 'PEOPLE'], ['pending', 'PENDING'], ['changes', 'CHANGES']];
const CAREER_CHANGES = ['hire', 'fire', 'quit', 'promote', 'job', 'salary', 'pattern'];
const MOOD_PRESETS = ['exhausted', 'energised', 'low', 'great', 'stressed', 'calm'];
const DEPART_HOW = ['moved_away', 'moved_out', 'written_out'];
const FLATMATE = ['stays', 'leaves', 'comes'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const NUMBERS = ['closeness', 'trust', 'tension', 'intimacy', 'passion', 'commitment'];
const ARC_END = ['fizzled', 'broken_up', 'done', 'cancelled'];

const opt = (value, label, selected) => html`<option value="${value}" ${selected ? 'selected' : ''}>${label ?? value}</option>`;
const dis = (ro) => (ro ? 'disabled' : '');
const nowSec = () => Math.floor(Date.now() / 1000);
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
// "in N hours" (blank = now) → {inMinutes} for the planner's `when` form.
const laterOf = (hours) => {
  const h = num(hours);
  return finite(h) && h > 0 ? { when: { inMinutes: Math.min(1440, Math.round(h * 60)) } } : {};
};
// "on day N at HH:MM" → the planner's absolute startAt (local day + time are resolved server-side via {date,time}).
const dayTimeOf = (form, dayName = 'day', timeName = 'time') => {
  const d = num(form.elements.namedItem(dayName)?.value);
  const t = String(form.elements.namedItem(timeName)?.value || '').trim();
  if (!finite(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null;
  // The calendar date N days from now in the bot's time zone (en-CA formats as YYYY-MM-DD).
  let date = null;
  try { date = new Intl.DateTimeFormat('en-CA', { timeZone: getTimezone() || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86400_000)); } catch { date = null; }
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date, time: t } : null;
};

// 016: an outing-like decision (social / family, a go option) can take a tone hint for its scene.
export const toneable = (d) => (typeof d?.toneable === 'boolean' ? d.toneable
  : (d?.category === 'social' || d?.category === 'family') && (d.options || []).some((o) => o.id === 'go'));

export function decisionRow(d, ro) {
  const opts = (d.options || []).map((o) => opt(o.id, `${upper(o.id)} · ${o.label || ''}`, o.id === d.committed));
  return html`<tr>
    <td class="mono">${fmtTime(d.eventAt)}</td>
    <td>${upper(d.kind)}${d.place ? html` <span class="mute">· ${d.place}</span>` : ''}${d.with?.length ? html` <span class="mute">· with ${d.with.join(', ')}</span>` : ''}${d.realPerson ? html` <span class="chip warn">REAL PERSON</span>` : d.fromChat ? html` <span class="chip">FROM A CHAT</span>` : ''}</td>
    <td><span class="chip">${upper(d.status)}${d.committed ? ` · ${upper(d.committed)}` : ''}</span>${d.outcome ? html` <span class="chip warn">${upper(d.outcome)}</span>` : ''}</td>
    <td><select data-pick="${d.id}" aria-label="Option" ${dis(ro)}>${opts}</select> <button type="button" data-god-act="pick" data-id="${d.id}" ${dis(ro)}>PICK</button></td>
    <td>${d.outcome
      ? html`<span class="mute mono">SET · revert it under PENDING / on the Timeline (#${d.outcomeEventId})</span>`
      : html`<select data-outcome="${d.id}" aria-label="Outcome" ${dis(ro)}>${(d.realPerson ? ['cancelled'] : ['well', 'badly', 'cancelled']).map((o) => opt(o, upper(o)))}</select> <button type="button" data-god-act="outcome" data-id="${d.id}" ${dis(ro)}>SET</button>`}</td>
    <td>${toneable(d) ? html`<input class="god-tone" data-tone="${d.id}" maxlength="${TONE_MAX}" list="ldgToneChips" placeholder="${d.tone ? d.tone : 'how should it go? (optional)'}" aria-label="Tone hint" ${dis(ro)}>
        <select data-tone-outcome="${d.id}" aria-label="The hint's outcome" ${dis(ro)}><option value="">OUTCOME</option>${OUTCOME_WORDS.map((o) => opt(o, upper(o)))}</select>
        <button type="button" data-god-act="tone" data-id="${d.id}" ${dis(ro)}>TONE</button>${d.tone ? html`<div class="mono mute">NOW: ${d.tone}${d.toneOutcome ? ` · ${upper(d.toneOutcome)}` : ''}</div>` : ''}`
      : html`<span class="mute mono">—</span>`}</td>
  </tr>`;
}

function outcomesView(v, ro) {
  const rows = Array.isArray(v.decisions) ? v.decisions : [];
  return html`<div class="mono mute">His upcoming decisions, plans he made in a chat among them. A REAL PERSON's plan takes only a pick or a cancel, and if that means he has to tell them, the preview says so first. An outing's TONE HINT is used when its scene is written after it ends, with the OUTCOME it implies (the hint sets the outcome, so pick one with it; SET sends the hint too when one is typed, with SET's outcome).</div>
    <div class="scene-chips god-tone-chips"><span class="mono mute">TONE HINTS ·</span> ${TONE_CHIPS.map((t) => html`<button type="button" class="chip" data-tone-chip="${t}" ${dis(ro)}>${t}</button> `)}</div>
    <datalist id="ldgToneChips">${TONE_CHIPS.map((t) => html`<option value="${t}"></option>`)}</datalist>
    <table class="data"><thead><tr><th>WHEN</th><th>WHAT</th><th>NOW</th><th>PICK FOR HIM</th><th>HOW IT TURNS OUT</th><th>TONE HINT (OPTIONAL)</th></tr></thead><tbody>
    ${rows.length ? rows.map((d) => decisionRow(d, ro)) : html`<tr><td colspan="6" class="empty">NOTHING UPCOMING</td></tr>`}
    </tbody></table>`;
}

function careerView(v, ro) {
  const c = v.career || {};
  const pat = c.pattern || null;
  return html`<div class="mono">${c.employed ? html`<b>EMPLOYED</b> · ${c.title || '—'}${c.employerName ? ` · ${c.employerName}` : ''}${finite(c.salary) ? ` · salary ${c.salary}` : ''}${c.office ? ` · office ${c.office}` : ''}` : html`<b class="amber">OUT OF WORK</b>`}${c.hunting ? html` <span class="chip">HUNTING</span>` : ''}${c.notice ? html` <span class="chip">ON NOTICE</span>` : ''}${pat ? html` <span class="mute">office ${pat.officeDays.map((d) => WEEKDAYS[d]).join(',') || '—'} · home ${pat.wfhDays.map((d) => WEEKDAYS[d]).join(',') || '—'}</span>` : ''}</div>
    <form id="ldgCareer" class="story-form">
      <label>CHANGE <select name="change" ${dis(ro)}>${CAREER_CHANGES.map((k) => opt(k, upper(k)))}</select></label>
      <label>TITLE <input name="title" maxlength="60" placeholder="e.g. a new job title" ${dis(ro)}></label>
      <label>EMPLOYER <input name="employerName" maxlength="80" placeholder="a fictional company" ${dis(ro)}></label>
      <label>OFFICE <select name="officePlaceId" ${dis(ro)}>${[opt('', '— keep / none —'), ...(v.places || []).map((p) => opt(p.id, p.name))]}</select></label>
      <label>SALARY <input name="salary" type="number" min="0" step="1" ${dis(ro)}></label>
      <fieldset class="story-days"><legend>OFFICE DAYS (pattern)</legend>${WEEKDAYS.map((w, i) => html`<label><input type="checkbox" name="office" value="${i}" ${dis(ro)}> ${w}</label>`)}</fieldset>
      <fieldset class="story-days"><legend>FROM HOME (pattern)</legend>${WEEKDAYS.map((w, i) => html`<label><input type="checkbox" name="wfh" value="${i}" ${dis(ro)}> ${w}</label>`)}</fieldset>
      <label>FROM IN (HOURS, BLANK = NOW) <input name="inHours" type="number" min="0" max="24" step="0.5" ${dis(ro)}></label>
      <label>OR ON DAY (0–60) <input name="day" type="number" min="0" max="60" ${dis(ro)}></label>
      <label>AT <input name="time" placeholder="09:00" maxlength="5" ${dis(ro)}></label>
      <button type="button" class="primary" data-god-act="career" ${dis(ro)}>PREVIEW</button>
    </form>`;
}

function moneyView(v, ro) {
  return html`<div class="mono">BALANCE <b>${finite(v.money) ? v.money : '—'}</b></div>
    <form id="ldgMoney" class="story-form">
      <label>MODE <select name="mode" ${dis(ro)}>${['income', 'expense', 'set'].map((k) => opt(k, upper(k)))}</select></label>
      <label>AMOUNT <input name="amount" type="number" step="1" required ${dis(ro)}></label>
      <label>LABEL <input name="label" maxlength="80" placeholder="optional, e.g. a bonus" ${dis(ro)}></label>
      <button type="button" class="primary" data-god-act="money" ${dis(ro)}>PREVIEW</button>
    </form>`;
}

function homeView(v, ro, areas = [], areaQ = '') {
  return html`<div class="mono">HOME <b>${v.home?.name || '—'}</b> <span class="mute">· a new home sits at neighbourhood level (~1 km), never an address</span></div>
    <form id="ldgHome" class="story-form">
      <label>NEAR <select name="near" ${dis(ro)}>${(v.places || []).map((p) => opt(p.id, p.name))}</select></label>
      <label>OR AN AREA <input name="areaQ" maxlength="80" placeholder="a neighbourhood" value="${areaQ}" ${dis(ro)}></label>
      <button type="button" data-god-act="home-area-search" ${dis(ro)}>SEARCH AREAS</button>
      <label>AREA <select name="area" ${dis(ro)}><option value="">— near the place above —</option>${areas.map((a, i) => opt(String(i), a.name, i === 0))}</select></label>
      <label>FLATMATE <select name="flatmate" ${dis(ro)}>${FLATMATE.map((k) => opt(k, upper(k)))}</select></label>
      <label>MOVES IN (HOURS, BLANK = NOW) <input name="inHours" type="number" min="0" max="24" step="0.5" ${dis(ro)}></label>
      <label>OR ON DAY (0–60) <input name="day" type="number" min="0" max="60" ${dis(ro)}></label>
      <label>AT <input name="time" placeholder="10:00" maxlength="5" ${dis(ro)}></label>
      <button type="button" class="primary" data-god-act="home" ${dis(ro)}>PREVIEW</button>
    </form>`;
}

function moodView(v, ro) {
  return html`<form id="ldgMood" class="story-form">
      <label>FEELS <select name="preset" ${dis(ro)}>${MOOD_PRESETS.map((k) => opt(k, upper(k)))}</select></label>
      <label>WHEN HE WAKES ON DAY (0–13) <input name="wakeDay" type="number" min="0" max="13" placeholder="1 = tomorrow" ${dis(ro)}></label>
      <label>OR IN (HOURS) <input name="inHours" type="number" min="0.5" max="24" step="0.5" ${dis(ro)}></label>
      <label>LABEL <input name="label" maxlength="80" placeholder="optional" ${dis(ro)}></label>
      <button type="button" class="primary" data-god-act="mood" ${dis(ro)}>PREVIEW</button>
    </form>
    <form id="ldgHealth" class="story-form">
      <span class="mono">HEALTH · ${v.sick ? html`<b class="amber">SICK</b>` : 'WELL'}</span>
      <label>CHANGE <select name="change" ${dis(ro)}>${['sick', 'well'].map((k) => opt(k, upper(k)))}</select></label>
      <label>DAYS (1–14) <input name="days" type="number" min="1" max="14" value="1" ${dis(ro)}></label>
      <label>FROM IN (HOURS, BLANK = NOW) <input name="inHours" type="number" min="0" max="24" step="0.5" ${dis(ro)}></label>
      <button type="button" class="primary" data-god-act="health" ${dis(ro)}>PREVIEW</button>
    </form>`;
}

function peopleView(v, ro) {
  const cast = Array.isArray(v.cast) ? v.cast : [];
  const arcs = Array.isArray(v.arcs) ? v.arcs : [];
  const gone = Array.isArray(v.departed) ? v.departed : [];
  return html`<table class="data"><thead><tr><th>WHO</th>${NUMBERS.map((k) => html`<th>${upper(k)}</th>`)}<th></th></tr></thead><tbody>
    ${cast.map((m) => html`<tr data-member="${m.id}"><td>${m.name} <span class="mute">${m.relation || ''}</span>${m.pinned ? html` <span class="chip">PINNED</span>` : ''}</td>
      ${NUMBERS.map((k) => html`<td><input class="story-num" name="${k}" type="number" min="0" max="1" step="0.05" placeholder="${finite(m[k]) ? fx(m[k]) : '—'}" aria-label="${k}" ${dis(ro)}></td>`)}
      <td><button type="button" data-god-act="numbers" data-id="${m.id}" ${dis(ro)}>SET</button>
        <select data-how="${m.id}" aria-label="How they leave" ${dis(ro)}>${DEPART_HOW.map((k) => opt(k, upper(k)))}</select>
        <button type="button" data-god-act="depart" data-id="${m.id}" ${dis(ro)}>WRITE OUT</button></td></tr>`)}
    </tbody></table>
    ${gone.length ? html`<div class="story-sub mono">LEFT HIS LIFE</div><table class="data"><tbody>${gone.map((m) => html`<tr><td>${m.name} <span class="mute">${m.relation || ''}</span></td><td class="mono">${upper(m.how)}${m.at ? ` · ${fmtRelative(m.at)} ago` : ''}</td><td><button type="button" data-god-act="return" data-id="${m.id}" ${dis(ro)}>BRING BACK</button></td></tr>`)}</tbody></table>` : ''}
    ${arcs.length ? html`<div class="story-sub mono">END A STORYLINE</div><table class="data"><tbody>${arcs.map((a) => html`<tr><td class="mono">#${a.id} ${upper(a.category)} · ${upper(a.stage)}${a.with?.length ? ` · ${a.with.join(', ')}` : ''}</td><td><select data-arcend="${a.id}" aria-label="Outcome" ${dis(ro)}>${ARC_END.map((k) => opt(k, upper(k)))}</select> <button type="button" data-god-act="arcend" data-id="${a.id}" ${dis(ro)}>END</button></td></tr>`)}</tbody></table>` : ''}`;
}

function pendingView(v, ro) {
  const rows = Array.isArray(v.pending) ? v.pending : [];
  return html`<div class="mono mute">Scheduled changes not yet due. REVERT undoes one before it happens; once it happened, make a new change or rewind.</div>
    <table class="data"><thead><tr><th>#</th><th>WHAT</th><th>DUE</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((p) => html`<tr><td class="mono">${p.id}</td><td>${upper(p.type)}</td><td class="mono">${p.dueAt ? fmtTime(p.dueAt) : p.wakeDate ? `wake on ${p.wakeDate}` : '—'}</td>
      <td><button type="button" data-god-act="revert-event" data-id="${p.id}" ${dis(ro)}>REVERT</button></td></tr>`)
      : html`<tr><td colspan="4" class="empty">NOTHING SCHEDULED</td></tr>`}
    </tbody></table>`;
}

function changesView(v, ro) {
  const rows = Array.isArray(v.changes) ? v.changes : [];
  return html`<div class="mono mute">Recent Director changes. REVERT THIS CHANGE undoes everything one change did (its own events and what they caused), after a preview. A part that already happened can't be undone this way: the preview says which.</div>
    <table class="data"><thead><tr><th>#</th><th>WHAT</th><th>WHEN</th><th>EVENTS</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((c) => html`<tr><td class="mono">${c.id}</td><td>${changeText(c)}</td><td class="mono">${fmtRelative(c.at)} ago</td><td class="mono">${c.count ?? '—'}</td>
      <td><button type="button" data-god-act="revert-change" data-id="${c.id}" ${dis(ro)}>REVERT THIS CHANGE</button></td></tr>`)
      : html`<tr><td colspan="5" class="empty">NO CHANGES YET</td></tr>`}
    </tbody></table>`;
}

// A change in words (the server's code-built description), else its kind.
export function changeText(c) {
  return typeof c?.description === 'string' && c.description ? c.description : upper(c?.kind ?? 'change');
}

// The typed tone hint of a decision row ('' when none), capped like the server.
function toneOf(slot, id) {
  return String($(slot, `[data-tone="${id}"]`)?.value || '').replace(/\s+/g, ' ').trim().slice(0, TONE_MAX);
}

const VIEWS = { outcomes: outcomesView, career: careerView, money: moneyView, home: homeView, mood: moodView, people: peopleView, pending: pendingView, changes: changesView };

// The confirm's card: what the revert undoes (targets), what goes with them
// (riding: a picked venue's recorded routes, a decision's own follow-ups) and
// what refuses.
export function revertConfirmCard(p) {
  const targets = Array.isArray(p?.targets) ? p.targets : [];
  const riding = Array.isArray(p?.riding) ? p.riding : [];
  const refusals = Array.isArray(p?.refusals) ? p.refusals : [];
  return html`<div class="story-modal-card" tabindex="-1">
    <div class="panel-head"><span>REVERT THIS CHANGE · #${p.actionEventId} ${upper(p.kind)}</span></div>
    <div class="panel-body">
      ${p.description ? html`<p class="mono">${p.description}</p>` : ''}
      ${(p?.continuity?.warnings ?? []).map((w) => html`<p class="mono warn">${w.text}</p>`)}
      ${refusals.length ? html`<div class="story-refusals"><b class="red">CAN'T REVERT AS A WHOLE</b>${refusals.map((r) => html` <span class="chip bad">${r.type} #${r.id} · ${upper(r.reason)}</span>`)}</div>
        <div class="mono mute">It already happened in his life (or something else uses it). Make a new change, or rewind.</div>` : ''}
      <div class="story-sub mono">WOULD REVERT (${targets.length})</div>
      <ol class="story-events mono">${targets.map((t) => html`<li>${t.type} <span class="mute">#${t.id}</span></li>`)}</ol>
      ${riding.length ? html`<div class="story-sub mono">ALSO GOES WITH IT (${riding.length})</div>
        <ol class="story-events mono">${riding.map((t) => html`<li>${t.type} <span class="mute">#${t.id}</span></li>`)}</ol>` : ''}
      <div class="mono mute">Each revert also takes what that event caused. Nothing is deleted: the log keeps the record.</div>
    </div>
    <div class="story-modal-foot">
      <button type="button" data-act="close">CANCEL</button>
      <button type="button" class="primary" data-act="go" ${refusals.length || !targets.length ? 'disabled' : ''}>REVERT ${targets.length} EVENT${targets.length === 1 ? '' : 'S'}</button>
    </div></div>`;
}

// The REVERT THIS CHANGE confirm: what would be undone, what refuses. → true when reverted.
function confirmRevert(ctx, p) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'story-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Revert this change');
    document.body.appendChild(box);
    let done = false;
    const close = (ok) => { if (done) return; done = true; box.remove(); resolve(ok); };
    ctx.onDispose(() => close(false));
    render(box, revertConfirmCard(p));
    box.addEventListener('click', async (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (e.target === box || act === 'close') { close(false); return; }
      if (act !== 'go') return;
      e.target.disabled = true;
      try {
        const r = await api('/api/director/revert-change', { method: 'POST', body: { actionEventId: p.actionEventId, fingerprint: p.fingerprint } });
        flash(`REVERTED · ${r?.reverted?.length ?? 0} EVENTS`);
        close(true);
      } catch (err) {
        flash(err.message, 'bad');
        close(false);
      }
    });
  });
}

/**
 * Mount the panel into `slot` (an element inside the Director page).
 * deps: { openPreview(action, title) → Promise<{applied}>, readOnly() → bool, onChanged() }
 */
export function mountGodPanel(ctx, slot, deps) {
  if (!slot) return { load: async () => {} };
  let tab = 'outcomes';
  let view = { enabled: false };
  let areas = [];   // the last AREA search (HOME): [{name, lat, lon}] from the server
  let areaQ = '';
  const views = { ...VIEWS, home: (v, r) => homeView(v, r, areas, areaQ) };
  const ro = () => deps.readOnly() || !view.enabled;
  const paint = () => {
    const body = views[tab] ? views[tab](view, ro()) : '';
    render(slot, html`<div class="story-tabs" role="tablist">${TABS.map(([k, label]) => html`<button type="button" role="tab" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}" data-god-tab="${k}">${label}</button>`)}</div>
      <div class="god-body">${view.enabled ? body : html`<div class="empty">THE STORY IS OFF · PLAY GOD NEEDS LIFE AND THE ARCS SKILL</div>`}</div>`);
  };
  async function load() {
    try {
      view = await api('/api/director/god', { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      view = { enabled: false };
    }
    if (!ctx.alive()) return;
    if (!slot.contains(document.activeElement)) paint();
  }
  const after = (r) => { if (r?.applied) { deps.onChanged?.(); load().catch(() => {}); } };
  const go = (action, title) => deps.openPreview(action, title).then(after);

  let lastTone = null;   // the tone input a TONE HINTS chip fills (the last one focused, else the first)
  slot.addEventListener('focusin', (e) => { if (e.target.matches?.('[data-tone]')) lastTone = e.target.dataset.tone; });
  slot.addEventListener('click', async (e) => {
    const tc = e.target.closest?.('[data-tone-chip]');
    if (tc) {
      const inp = (lastTone && $(slot, `[data-tone="${lastTone}"]`)) || $(slot, '[data-tone]');
      if (inp && !inp.disabled) {
        inp.value = tc.dataset.toneChip;
        const sel = $(slot, `[data-tone-outcome="${inp.dataset.tone}"]`);
        if (sel && TONE_OUTCOME[tc.dataset.toneChip]) sel.value = TONE_OUTCOME[tc.dataset.toneChip];
        inp.focus();
      } else if (!inp) flash('NO OUTING TO SET A TONE FOR', 'bad');
      return;
    }
    const t = e.target.closest?.('[data-god-tab]');
    if (t) { tab = t.dataset.godTab; paint(); return; }
    const b = e.target.closest?.('[data-god-act]');
    if (!b || ro()) return;
    const act = b.dataset.godAct;
    const id = b.dataset.id;
    const idNum = Number(id);
    if (act === 'pick') {
      go({ kind: 'decision.pick', decisionId: idNum, optionId: $(slot, `[data-pick="${id}"]`)?.value }, 'PICK FOR HIM');
    } else if (act === 'outcome') {
      const tone = toneOf(slot, id);
      go({ kind: 'outcome', decisionId: idNum, outcome: $(slot, `[data-outcome="${id}"]`)?.value, ...(tone ? { tone } : {}) }, 'HOW IT TURNS OUT');
    } else if (act === 'tone') {
      const tone = toneOf(slot, id);
      if (!tone) { flash('TYPE A TONE HINT (OR PICK ONE)', 'bad'); return; }
      const outcome = $(slot, `[data-tone-outcome="${id}"]`)?.value;
      if (!OUTCOME_WORDS.includes(outcome)) { flash('PICK THE OUTCOME THE HINT IMPLIES', 'bad'); return; }
      go({ kind: 'scene.tone', decisionId: idNum, tone, outcome }, 'TONE HINT FOR THE SCENE');
    } else if (act === 'career') {
      const f = $(slot, '#ldgCareer');
      const change = f.elements.namedItem('change').value;
      const a = { kind: 'career', change };
      for (const k of ['title', 'employerName']) { const v = f.elements.namedItem(k).value.trim(); if (v) a[k] = v; }
      const office = f.elements.namedItem('officePlaceId').value;
      if (office && (change === 'hire' || change === 'job')) a.officePlaceId = office;
      const sal = num(f.elements.namedItem('salary').value);
      if (finite(sal)) a.salary = sal;
      const days = (n) => [...f.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => Number(x.value));
      if (change === 'pattern' || days('office').length || days('wfh').length) a.pattern = { officeDays: days('office'), wfhDays: days('wfh') };
      const at = dayTimeOf(f);
      Object.assign(a, at ? { when: at } : laterOf(f.elements.namedItem('inHours').value));
      go(a, `CAREER · ${upper(change)}`);
    } else if (act === 'money') {
      const f = $(slot, '#ldgMoney');
      const a = { kind: 'money', mode: f.elements.namedItem('mode').value, amount: num(f.elements.namedItem('amount').value) };
      const label = f.elements.namedItem('label').value.trim();
      if (label) a.label = label;
      if (!finite(a.amount)) { flash('AMOUNT?', 'bad'); return; }
      go(a, `MONEY · ${upper(a.mode)}`);
    } else if (act === 'home-area-search') {
      const q = String($(slot, '#ldgHome')?.elements.namedItem('areaQ')?.value || '').trim();
      if (!q) { flash('AN AREA TO SEARCH?', 'bad'); return; }
      areaQ = q;
      b.disabled = true;
      try {
        const res = await api('/api/places/search', { method: 'POST', body: { q, areas: true } });
        areas = (Array.isArray(res?.areas) ? res.areas : []).filter((a) => a && typeof a.name === 'string' && finite(a.lat) && finite(a.lon)).slice(0, 8);
        if (!areas.length) flash('NO AREA FOUND', 'bad');
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
      }
      if (ctx.alive()) paint();
    } else if (act === 'home') {
      const f = $(slot, '#ldgHome');
      const at = dayTimeOf(f);
      const pick = f.elements.namedItem('area').value;
      const area = pick !== '' ? areas[Number(pick)] : null;
      go({ kind: 'home', ...(area ? { area: { name: area.name, lat: area.lat, lon: area.lon } } : { near: f.elements.namedItem('near').value }),
        flatmate: f.elements.namedItem('flatmate').value,
        ...(at ? { when: at } : laterOf(f.elements.namedItem('inHours').value)) }, area ? 'HOME · MOVE TO AN AREA' : 'HOME · MOVE');
    } else if (act === 'mood') {
      const f = $(slot, '#ldgMood');
      const a = { kind: 'mood', preset: f.elements.namedItem('preset').value };
      const wd = num(f.elements.namedItem('wakeDay').value);
      if (finite(wd)) a.wakeDay = wd; else Object.assign(a, laterOf(f.elements.namedItem('inHours').value));
      if (a.wakeDay === undefined && !a.when) { flash('WAKE DAY OR HOURS?', 'bad'); return; }
      const label = f.elements.namedItem('label').value.trim();
      if (label) a.label = label;
      go(a, `MOOD · ${upper(a.preset)}`);
    } else if (act === 'health') {
      const f = $(slot, '#ldgHealth');
      const change = f.elements.namedItem('change').value;
      const a = { kind: 'health', change };
      if (change === 'sick') {
        a.days = num(f.elements.namedItem('days').value) || 1;
        Object.assign(a, laterOf(f.elements.namedItem('inHours').value));
      }
      go(a, `HEALTH · ${upper(change)}`);
    } else if (act === 'numbers') {
      const row = b.closest('tr');
      const a = { kind: 'cast.metrics', castId: id };
      for (const k of NUMBERS) { const v = num(row.querySelector(`input[name="${k}"]`)?.value); if (finite(v)) a[k] = v; }
      if (Object.keys(a).length === 2) { flash('SET AT LEAST ONE NUMBER', 'bad'); return; }
      go(a, 'NUMBERS');
    } else if (act === 'depart') {
      go({ kind: 'cast.depart', castId: id, how: $(slot, `[data-how="${id}"]`)?.value }, 'WRITE OUT');
    } else if (act === 'return') {
      go({ kind: 'cast.return', castId: id }, 'BRING BACK');
    } else if (act === 'arcend') {
      go({ kind: 'arc.end', arcId: idNum, outcome: $(slot, `[data-arcend="${id}"]`)?.value }, 'END STORYLINE');
    } else if (act === 'revert-event') {
      b.disabled = true;
      try {
        await api(`/api/life/events/${idNum}/revert`, { method: 'POST', body: { reason: 'owner: scheduled change undone' } });
        flash('REVERTED');
        deps.onChanged?.();
        await load();
      } catch (err) {
        flash(err.message, 'bad');
        b.disabled = false;
      }
    } else if (act === 'revert-change') {
      b.disabled = true;
      try {
        const p = await api('/api/director/revert-change', { method: 'POST', body: { actionEventId: idNum } });
        if (await confirmRevert(ctx, p)) { deps.onChanged?.(); await load(); }
      } catch (err) {
        flash(err.message, 'bad');
      } finally {
        if (ctx.alive()) b.disabled = false;
      }
    }
  });
  paint();
  return { load };
}
