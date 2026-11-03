// LIFE · DIRECTOR · SCHEDULE (spec 014 §A5.10, sched) — the owner's schedule
// edits: a day off or working from home / at the office (the whole day or from
// a time), up to three stretches on top (at home, out at a place, the gym, an
// errand, sleeping in, an early night), for today … +7 days. A stretch runs
// FROM a time or NOW TO a time or UNTIL SLEEP: the ticks send the server's own
// words 'now' / 'endOfDay' (a time input can't hold them — the presets used to
// leave an empty time behind → 400 bad_ranges). A preset clears the whole form
// first; PREVIEW checks the form (scheduleFormProblem) before sending it.
//
// PREVIEW (POST /api/director/preview, write mode + CSRF) shows the events, the
// conflicts with a resolution select per row (a change previews again), the
// refusals, the continuity warnings (015) and the projected rest of today +
// tomorrow before / after. A plan the edit would cancel is a red HIGH warning
// ("this cancels … at HH:MM") with KEEP IT INSTEAD (those rows on 'keep': the
// range trimmed around the plan); an owner / goal / adopted outing is kept by
// default. REVIEW & APPLY opens the page's preview modal for the
// same action (its continuity checks, story read, suggestions, the HIGH tick)
// and applies from there; the engine re-plans today at once. The list (GET /api/director/schedule) has CLEAR (a preview, then apply)
// and REVERT (only before the change takes effect; POST /api/life/events/:id/revert).
//
// Prompt drafts (spec 014 §A6): a `schedule` draft whose range — or a scene
// outing draft whose place — names a real venue shows the looked-up candidates
// (needs_pick) — picking one sets the range's (the outing's) candidateId and
// previews it like any draft — or says the lookup failed or is off
// (needs_venue: pick one of his known places instead; never a made-up place).
//
// Strings from the world, a model or the owner reach the DOM through html`` only.
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, el, $ } from '../core/dom.js';
import { fmtHm, fmtTime, fmtDay } from '../core/fmt.js';
import { flash } from './flash.js';

export const SCHEDULE_BACKGROUNDS = ['off', 'work_home', 'work_office'];
export const SCHEDULE_ACTIVITIES = ['home', 'out', 'gym', 'errand', 'sleep', 'work_home', 'work_office'];
export const WAKE_REASONS = ['cant_sleep', 'woken_up', 'early_start'];
const WAKE_LABELS = { cant_sleep: "HE CAN'T SLEEP", woken_up: 'SOMETHING WOKE HIM', early_start: 'EARLY START (HIS DAY BEGINS)' };
const DAYS_MAX = 7;
const RANGES = 3;

const up = (s) => String(s ?? '').toUpperCase().replace(/[._]/g, ' ');
const opt = (value, label, selected) => html`<option value="${value}" ${selected ? 'selected' : ''}>${label ?? value}</option>`;
const dis = (ro) => (ro ? 'disabled' : '');
const nowSec = () => Math.floor(Date.now() / 1000);
const dayLabel = (i) => (i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : `+${i} · ${fmtDay((nowSec() + i * 86400) * 1000)}`);

// Built at mount (the day labels need the bot's time zone from /api/status).
const panelHtml = () => html`
<div class="panel" data-panel="schedule" style="margin-top:14px">
  <div class="panel-head"><span>SCHEDULE<button type="button" class="guide-q" data-guide="schedule" aria-label="Guide: schedule">?</button></span><span class="mono mute">A DAY OFF · WFH · STRETCHES · SLEEP IN · THE PREVIEW SHOWS HIS DAY</span></div>
  <div class="panel-body">
    <div class="story-buttons">
      <button type="button" class="ld-s-preset" data-preset="rest_off">REST OF TODAY OFF</button>
      <button type="button" class="ld-s-preset" data-preset="wfh_tomorrow">WFH TOMORROW</button>
      <button type="button" class="ld-s-preset" data-preset="stay_in">STAY IN TONIGHT</button>
      <button type="button" class="ld-s-preset" data-preset="sleep_in">SLEEP IN TOMORROW</button>
    </div>
    <form id="ldSched" class="story-form" autocomplete="off">
      <label>DAY <select name="day" aria-label="Day">${Array.from({ length: DAYS_MAX + 1 }, (_, i) => opt(String(i), dayLabel(i), i === 0))}</select></label>
      <label>BACKGROUND <select name="bg" aria-label="Background"><option value="">— none —</option>${SCHEDULE_BACKGROUNDS.map((b) => opt(b, up(b)))}</select></label>
      <label>FROM <select name="bgWhen" aria-label="Background from"><option value="whole">THE WHOLE DAY</option><option value="now">NOW</option><option value="time">A TIME</option></select>
        <input type="time" name="bgFrom" aria-label="Background from time"></label>
      ${Array.from({ length: RANGES }, (_, i) => html`<fieldset class="story-form-row" data-range="${i}"><legend class="mono mute">STRETCH ${i + 1}</legend>
        <label>WHAT <select name="r${i}act" aria-label="Stretch ${i + 1}"><option value="">—</option>${SCHEDULE_ACTIVITIES.map((a) => opt(a, up(a)))}</select></label>
        <label>FROM <input type="time" name="r${i}from" aria-label="Stretch ${i + 1} from"></label>
        <label class="chip"><input type="checkbox" name="r${i}now" data-time="r${i}from"> NOW</label>
        <label>TO <input type="time" name="r${i}to" aria-label="Stretch ${i + 1} to"></label>
        <label class="chip"><input type="checkbox" name="r${i}eod" data-time="r${i}to"> UNTIL SLEEP</label>
        <label>WHERE <select name="r${i}place" data-fill="place" data-optional="1" aria-label="Stretch ${i + 1} place"></select></label>
        <label>WITH <select name="r${i}cast" data-fill="cast" data-optional="1" aria-label="Stretch ${i + 1} with"></select></label>
        <label>LABEL <input type="text" name="r${i}label" maxlength="80"></label>
      </fieldset>`)}
    </form>
    <button type="button" class="primary" id="ldSchedGo">PREVIEW SCHEDULE</button>
    <form id="ldWake" class="story-form" autocomplete="off" style="margin-top:10px">
      <fieldset class="story-form-row"><legend class="mono mute">WAKE HIM · HE CAN'T SLEEP (WHILE HE IS ASLEEP TONIGHT)</legend>
        <label>WHY <select name="reason" aria-label="Why he wakes">${WAKE_REASONS.map((r, i) => opt(r, WAKE_LABELS[r], i === 0))}</select></label>
        <label>AT <input type="time" name="at" aria-label="Wake at (empty: now)"></label>
        <label>BACK TO SLEEP AT <input type="time" name="until" aria-label="Back to sleep at (empty: after a while)"></label>
      </fieldset>
    </form>
    <button type="button" id="ldWakeGo">PREVIEW WAKE</button>
    <div data-slot="ld-sched-preview"></div>
    <div class="story-sub mono">SCHEDULE CHANGES</div>
    <div data-slot="ld-sched-list"></div>
  </div>
</div>`;

// A time input's value as HH:MM ('' when empty or half typed — a 12-hour picker
// without its am/pm reads '' — and seconds dropped).
const hhmmOf = (x) => (/^\d\d:\d\d/.test(String(x?.value ?? '')) ? String(x.value).slice(0, 5) : '');

/**
 * The SCHEDULE form → a `schedule` action (times as HH:MM on that day; the server
 * resolves them). NOW / UNTIL SLEEP send the server's own words 'now' / 'endOfDay'
 * (a time input can't hold them).
 */
export function scheduleAction(form) {
  const v = (n) => form.elements.namedItem(n)?.value ?? '';
  const t = (n) => hhmmOf(form.elements.namedItem(n));
  const on = (n) => form.elements.namedItem(n)?.checked === true;
  const a = { kind: 'schedule', day: Math.min(DAYS_MAX, Math.max(0, Number(v('day')) || 0)) };
  if (v('bg')) {
    const when = v('bgWhen');
    a.background = when === 'whole' ? { activity: v('bg'), wholeDay: true }
      : { activity: v('bg'), from: when === 'now' ? 'now' : t('bgFrom'), to: 'endOfDay' };
  }
  const ranges = [];
  for (let i = 0; i < RANGES; i++) {
    const act = v(`r${i}act`);
    if (!act) continue;
    const r = { activity: act, from: on(`r${i}now`) ? 'now' : t(`r${i}from`), to: on(`r${i}eod`) ? 'endOfDay' : t(`r${i}to`) };
    if (v(`r${i}place`) && ['out', 'gym', 'errand'].includes(act)) r.placeId = v(`r${i}place`);
    if (v(`r${i}cast`)) r.castIds = [v(`r${i}cast`)];
    if (v(`r${i}label`).trim()) r.label = v(`r${i}label`).trim();
    ranges.push(r);
  }
  if (ranges.length) a.ranges = ranges;
  return a;
}

/**
 * What the SCHEDULE form is missing before it is sent, in words ('' when fine):
 * a stretch / background without a time (or a half-typed one), NOW past today,
 * stretches that overlap each other, nothing to change.
 */
export function scheduleFormProblem(form) {
  const a = scheduleAction(form);
  const bad = (n) => form.elements.namedItem(n)?.validity?.badInput === true;
  if (a.background && !a.background.wholeDay && !a.background.from) return 'BACKGROUND FROM: PICK A TIME, OR NOW';
  if ((a.background?.from === 'now' || (a.ranges || []).some((r) => r.from === 'now')) && a.day !== 0) return 'NOW IS FOR TODAY ONLY';
  for (let i = 0, k = 0; i < RANGES; i++) {
    if (!form.elements.namedItem(`r${i}act`)?.value) continue;
    const r = a.ranges[k++];
    if (!r.from) return `STRETCH ${i + 1} FROM: ${bad(`r${i}from`) ? 'THE TIME IS NOT COMPLETE (HOUR, MINUTES AND AM/PM)' : 'PICK A TIME, OR NOW'}`;
    if (!r.to) return `STRETCH ${i + 1} TO: ${bad(`r${i}to`) ? 'THE TIME IS NOT COMPLETE (HOUR, MINUTES AND AM/PM)' : 'PICK A TIME, OR UNTIL SLEEP'}`;
  }
  const hm = (x) => (/^\d\d:\d\d$/.test(x) ? x : null);
  const timed = (a.ranges || []).filter((r) => hm(r.from) && hm(r.to) && r.from < r.to).sort((x, y) => (x.from < y.from ? -1 : 1));
  for (let i = 1; i < timed.length; i++) if (timed[i].from < timed[i - 1].to) return 'TWO STRETCHES OVERLAP: CLEAR ONE (SET ITS WHAT TO —)';
  if (!a.background && !a.ranges) return 'NOTHING TO CHANGE: PICK A BACKGROUND OR A STRETCH';
  return '';
}

/**
 * The form showing `a` (a preset, or a schedule action): every field cleared
 * first, so nothing of an earlier preset is left behind; 'now' / 'endOfDay'
 * tick NOW / UNTIL SLEEP (their time inputs off).
 */
export function fillScheduleForm(f, a) {
  if (!f || !a) return;
  f.reset?.();
  const set = (n, v) => { const x = f.elements.namedItem(n); if (x) x.value = v; };
  const tick = (n, on) => { const x = f.elements.namedItem(n); if (x) x.checked = on; };
  set('day', String(a.day ?? 0));
  set('bg', '');
  for (let i = 0; i < RANGES; i++) {
    for (const n of ['act', 'from', 'to', 'place', 'cast', 'label']) set(`r${i}${n}`, '');
    tick(`r${i}now`, false);
    tick(`r${i}eod`, false);
  }
  if (a.background) {
    set('bg', a.background.activity);
    set('bgWhen', a.background.wholeDay ? 'whole' : a.background.from === 'now' ? 'now' : 'time');
    if (!a.background.wholeDay && a.background.from !== 'now') set('bgFrom', a.background.from);
  }
  (a.ranges || []).slice(0, RANGES).forEach((r, i) => {
    set(`r${i}act`, r.activity);
    tick(`r${i}now`, r.from === 'now');
    tick(`r${i}eod`, r.to === 'endOfDay');
    set(`r${i}from`, r.from === 'now' ? '' : r.from);
    set(`r${i}to`, r.to === 'endOfDay' ? '' : r.to);
  });
  syncTimes(f);
}

// NOW / UNTIL SLEEP ticked → their time input is off (the words are what is sent).
function syncTimes(f) {
  for (let i = 0; i < RANGES; i++) {
    for (const n of [`r${i}now`, `r${i}eod`]) {
      const box = f.elements.namedItem(n);
      const time = box?.dataset?.time ? f.elements.namedItem(box.dataset.time) : null;
      if (time) time.disabled = box.checked === true;
    }
  }
}

/** The WAKE HIM form → a `wake` action (empty AT = now; empty BACK TO SLEEP = after a while, later for a plan tonight). */
export function wakeAction(form) {
  const v = (n) => form?.elements?.namedItem(n)?.value ?? '';
  const reason = WAKE_REASONS.includes(v('reason')) ? v('reason') : 'cant_sleep';
  const a = { kind: 'wake', reason };
  if (/^\d\d:\d\d$/.test(v('at'))) a.at = v('at');
  if (reason !== 'early_start' && /^\d\d:\d\d$/.test(v('until'))) a.until = v('until');
  return a;
}

/** A preset → the form's values. */
export function presetAction(name) {
  switch (name) {
    case 'rest_off': return { kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' } };
    case 'wfh_tomorrow': return { kind: 'schedule', day: 1, background: { activity: 'work_home', wholeDay: true } };
    case 'stay_in': return { kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: 'now', to: 'endOfDay' }] };
    case 'sleep_in': return { kind: 'schedule', day: 1, ranges: [{ activity: 'sleep', from: '00:00', to: '10:30' }] };
    default: return null;
  }
}

function rowsTable(rows, placeName) {
  if (!rows?.length) return html`<div class="empty">NOTHING PLANNED</div>`;
  return html`<table class="data"><tbody>${rows.slice(0, 40).map((b) => html`<tr class="${b.fromOverride ? 'amber' : ''}">
    <td class="mono">${fmtHm(b.start)}</td><td class="mono">${fmtHm(b.end)}</td>
    <td>${b.kind}${b.fromOverride ? html` <span class="chip warn">EDIT</span>` : ''}</td>
    <td>${b.kind === 'commute' ? `${placeName(b.from)} → ${placeName(b.to)}` : placeName(b.placeId)}</td></tr>`)}</tbody></table>`;
}

function previewView(p, lists, ro) {
  const events = (Array.isArray(p?.events) ? p.events : []).filter((e) => e.type !== 'director.action');
  const x = p?.extra || {};
  const conflicts = Array.isArray(x.conflicts) ? x.conflicts : [];
  const warnings = Array.isArray(p?.warnings) ? p.warnings : [];
  const refusals = Array.isArray(p?.refusals) ? p.refusals : [];
  const proj = x.projection || null;
  const placeName = (id) => (id ? lists.places.find((q) => q.id === id)?.name || id : '—');
  // 015: the code's continuity warnings, here too (the modal has the rest).
  const cont = Array.isArray(p?.continuity?.warnings) ? p.continuity.warnings : [];
  const high = cont.some((w) => w.severity === 'high');
  return html`<div class="story-prompt-preview">
    <div class="mono">${x.date ? html`<b>${x.date}</b> · ` : ''}${x.dayType ? html`<span class="chip">${up(x.dayType)}</span> ` : ''}${events.map((e) => html`<span class="chip">${e.type} · ${e.actor}</span> `)}</div>
    ${warnings.length ? html`<div>${warnings.map((w) => html`<span class="amber mono">⚠ ${w}</span> `)}</div>` : ''}
    ${refusals.length ? html`<div><b class="red">REFUSED</b> ${refusals.map((r) => html`<span class="chip bad">${r.reason}${r.target ? ` · #${r.target}` : ''}</span> `)}</div>` : ''}
    ${cont.length ? html`<div class="story-sub mono">CONTINUITY (${cont.length})</div><ul class="story-warnings">${cont.map((w) => html`<li><span class="chip ${w.severity === 'high' ? 'bad' : w.severity === 'warn' ? 'warn' : ''}">${up(w.severity)}</span> <span class="mono mute">${w.code}</span> ${Array.isArray(w.keep) && w.keep.length ? html`<b class="red">${w.text || ''}</b> <button type="button" class="ld-s-keep" data-keys="${w.keep.join(',')}" ${dis(ro)}>KEEP ${w.keep.length === 1 ? 'IT' : 'THEM'} INSTEAD</button>` : w.text || ''}${w.fromChat ? html` <span class="mute">· from a chat</span>` : ''}</li>`)}</ul>` : ''}
    ${conflicts.length ? html`<div class="story-sub mono">CONFLICTS</div><table class="data"><thead><tr><th>WHAT</th><th>RESOLUTION</th><th>OUTCOME</th></tr></thead><tbody>
      ${conflicts.map((c) => html`<tr><td>${up(c.type)} · ${c.label || ''}${c.fromChat ? html` <span class="chip warn">FROM A CHAT</span>` : ''}${c.story ? html` <span class="chip">STORY</span>` : ''}</td>
        <td>${(c.choices || []).length > 1 ? html`<select class="ld-s-res" data-key="${c.type}:${c.id}" ${dis(ro)} aria-label="Resolution">${c.choices.map((ch) => opt(ch, up(ch), ch === c.resolution))}</select>` : html`<span class="chip">${up(c.resolution)}</span>`}</td>
        <td><span class="chip ${c.outcome === 'cancelled' ? 'bad' : ''}">${up(c.outcome)}</span>${c.trimmed ? html` <span class="mono mute">RANGE TRIMMED AROUND IT</span>` : ''}</td></tr>`)}</tbody></table>` : ''}
    ${x.skipped?.length ? html`<div class="mono mute">SKIPPED: ${x.skipped.join(', ')}</div>` : ''}
    ${proj?.timedOut ? html`<div class="mono amber">THE PROJECTION TOOK TOO LONG · APPLY STILL WORKS</div>`
      : proj ? html`<div class="story-sub mono">HIS DAY · BEFORE / AFTER (REST OF TODAY AND TOMORROW)</div>
        <div class="col-2"><div>${rowsTable(proj.before, placeName)}</div><div>${rowsTable(proj.after, placeName)}</div></div>` : ''}
    <div class="story-buttons"><button type="button" class="primary" id="ldSchedApply" ${dis(ro || !events.length)}>${events.length ? `REVIEW & APPLY ${events.length + 1} EVENTS` : 'NOTHING TO APPLY'}</button>
      <span class="mono mute">${high ? 'A HIGH WARNING: THE REVIEW ASKS FOR A TICK · ' : ''}EXPIRES ${fmtTime(p?.expiresAt)}</span></div>
  </div>`;
}

function listView(v, lists, ro) {
  const rows = Array.isArray(v?.overrides) ? v.overrides : [];
  if (!rows.length) return html`<div class="empty">NO SCHEDULE CHANGES</div>`;
  const placeName = (id) => (id ? lists.places.find((q) => q.id === id)?.name || id : '');
  return html`<table class="data"><tbody>${rows.map((o) => html`<tr>
    <td class="id">#${o.id}</td><td class="mono">${o.date}</td>
    <td>${o.background ? html`<span class="chip">${up(o.background.activity)}${o.background.wholeDay ? ' ALL DAY' : ` ${fmtHm(o.background.from)}–${fmtHm(o.background.to)}`}</span> ` : ''}
      ${(o.ranges || []).map((r) => html`<span class="chip">${up(r.activity)} ${fmtHm(r.from)}–${fmtHm(r.to)}${r.placeId ? ` · ${placeName(r.placeId)}` : ''}</span> `)}
      ${o.blockKind ? html`<span class="chip">${up(o.op)} ${o.blockKind}</span>` : ''}</td>
    <td>${o.status === 'active' ? html`<span class="chip ok">ACTIVE</span>` : html`<span class="chip">${up(o.status)}</span>`}</td>
    <td>${o.status === 'active' ? html`<button type="button" class="ld-s-clear" data-id="${o.id}" ${dis(ro)}>CLEAR</button>` : ''}
      ${o.revertible ? html` <button type="button" class="ld-s-revert" data-id="${o.id}" ${dis(ro)}>REVERT</button>` : ''}</td></tr>`)}</tbody></table>`;
}

/**
 * The venue picker of a prompt draft that names a real venue — a `schedule`
 * range, or a scene outing's place (slot `field: 'place'`): needs_pick → the
 * looked-up candidates; needs_venue (the lookup failed or is off) → one of his
 * known places (`places`: [{id, name}]). '' for any other draft.
 */
export function scheduleDraftVenues(d, i, ro, places = []) {
  if (d?.status !== 'needs_pick' && d?.status !== 'needs_venue') return '';
  const venues = Array.isArray(d.venues) ? d.venues : [];
  const slot = (v) => (v.field === 'place' ? 'place' : String(v.range));
  return html`<div class="story-prompt-venues">${venues.map((v) => html`<div class="mono">
    <b>${v.field === 'place' ? 'REAL PLACE FOR THE OUTING' : `REAL PLACE FOR STRETCH ${v.range + 1}`}:</b> ${v.query?.name || '—'}${v.query?.area ? ` · ${v.query.area}` : ''}
    ${Array.isArray(v.candidates) && v.candidates.length
      ? v.candidates.map((c) => html` <button type="button" class="ld-p-venue" data-card="${i}" data-slot="${slot(v)}" data-id="${c.id}" ${dis(ro)}>${c.name}${c.area ? ` · ${c.area}` : ''}${Number.isFinite(c.distKmFromHome) ? ` · ${c.distKmFromHome} km` : ''}</button>`)
      : html` <span class="amber">LOOKUP FAILED OR OFF · PICK ONE OF HIS KNOWN PLACES</span>
        <select class="ld-p-known" data-card="${i}" data-slot="${slot(v)}" aria-label="A known place instead" ${dis(ro)}>
          <option value="">— a known place —</option>${(Array.isArray(places) ? places : []).map((p) => opt(p.id, p.name || p.id, false))}
        </select>`}
  </div>`)}</div>`;
}

// A pick (a candidate id, or a known place id) → the draft's action; the slot
// leaves the venue list, and the draft is plannable once none is left.
function pickVenue(c, slotKey, pick) {
  const a = c.draft.action;
  if (slotKey === 'place') {
    c.draft.action = { ...a, ...pick };
    c.draft.venues = (c.draft.venues || []).filter((v) => v.field !== 'place');
  } else {
    const range = Number(slotKey);
    if (!a?.ranges?.[range]) return false;
    c.draft.action = { ...a, ranges: a.ranges.map((x, k) => (k === range ? { ...x, ...pick } : x)) };
    c.draft.venues = (c.draft.venues || []).filter((v) => v.field === 'place' || v.range !== range);
  }
  if (!c.draft.venues.length) { c.draft.status = null; c.draft.venues = null; }
  return true;
}

/**
 * Mount the SCHEDULE panel after the goals panel. opts: { lists, ro(), onApplied(),
 * openPreview(action, title) → Promise<{applied}> (the page's modal: continuity,
 * story read, suggestions, the HIGH tick), prompt (the page's draft cards),
 * renderPrompt(), previewCard(card) }.
 */
export function mountSchedulePanel(ctx, root, opts) {
  const { lists, ro } = opts;
  const host = el('div', { 'data-host': 'schedule' });
  const anchor = $(root, '#ldGoal')?.closest('.col-2');
  if (anchor) anchor.after(host); else root.appendChild(host);
  render(host, panelHtml());
  let last = null;
  let action = null;
  let resolutions = {};

  async function loadList() {
    for (const n of host.querySelectorAll('#ldSchedGo, #ldWakeGo, .ld-s-preset')) n.disabled = ro();
    try {
      const v = await api('/api/director/schedule', { signal: ctx.signal });
      if (ctx.alive()) setSlot(host, 'ld-sched-list', listView(v, lists, ro()));
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) setSlot(host, 'ld-sched-list', html`<div class="mono red">${err.message}</div>`);
    }
  }
  async function runPreview(a) {
    action = a;
    setSlot(host, 'ld-sched-preview', html`<div class="loading">PREVIEWING · NOTHING IS WRITTEN</div>`);
    try {
      last = await api('/api/director/preview', { method: 'POST', body: { action: { ...a, ...(Object.keys(resolutions).length ? { resolutions } : {}) } } });
      if (ctx.alive()) setSlot(host, 'ld-sched-preview', previewView(last, lists, ro()));
    } catch (err) {
      if (isAbort(err) || !ctx.alive()) return;
      last = null;
      setSlot(host, 'ld-sched-preview', html`<div class="mono red">PREVIEW REFUSED · ${err.message}</div>`);
    }
  }
  const fillForm = (a) => fillScheduleForm($(host, '#ldSched'), a);

  ctx.listen(host, 'click', async (e) => {
    const t = e.target.closest?.('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('ld-s-preset')) {
      const a = presetAction(t.dataset.preset);
      fillForm(a);
      resolutions = {};
      runPreview(a);
    } else if (t.id === 'ldSchedGo') {
      resolutions = {};
      const form = $(host, '#ldSched');
      const problem = scheduleFormProblem(form);
      if (problem) { setSlot(host, 'ld-sched-preview', html`<div class="mono amber">CHECK THE FORM · ${problem}</div>`); return; }
      runPreview(scheduleAction(form));
    } else if (t.id === 'ldWakeGo') {
      resolutions = {};
      runPreview(wakeAction($(host, '#ldWake')));
    } else if (t.id === 'ldSchedApply' && last && action) {
      // 015: every Director change is applied through the modal's continuity review.
      if (typeof opts.openPreview !== 'function') return;
      t.disabled = true;
      const full = { ...action, ...(Object.keys(resolutions).length ? { resolutions } : {}) };
      const r = await opts.openPreview(full, `SCHEDULE · ${up(full.kind)}`);
      if (!ctx.alive()) return;
      if (r?.applied) {
        flash('HE RE-PLANS NOW');
        last = null;
        setSlot(host, 'ld-sched-preview', null);
        loadList();
        opts.onApplied?.();
      } else t.disabled = false;
    } else if (t.classList.contains('ld-s-keep') && action) {
      // A cancel the owner didn't mean: those rows on 'keep' (the range trimmed around them).
      const keys = String(t.dataset.keys || '').split(',').filter((k) => /^(?:decision|goal|invite):\d{1,15}$/.test(k));
      if (!keys.length) return;
      resolutions = { ...resolutions, ...Object.fromEntries(keys.map((k) => [k, 'keep'])) };
      runPreview(action);
    } else if (t.classList.contains('ld-s-clear')) {
      resolutions = {};
      runPreview({ kind: 'schedule.clear', overrideId: Number(t.dataset.id) });
    } else if (t.classList.contains('ld-s-revert')) {
      t.disabled = true;
      try {
        await api(`/api/life/events/${Number(t.dataset.id)}/revert`, { method: 'POST', body: { reason: 'schedule panel' } });
        flash(`REVERTED #${t.dataset.id}`);
        loadList();
        opts.onApplied?.();
      } catch (err) {
        if (!isAbort(err)) { flash(err.message, 'bad'); t.disabled = false; }
      }
    }
  });
  ctx.listen(host, 'change', (e) => {
    const t = e.target;
    if (t.dataset?.time) { syncTimes($(host, '#ldSched')); return; }
    if (!t.classList?.contains('ld-s-res') || !action) return;
    resolutions = { ...resolutions, [t.dataset.key]: t.value };
    runPreview(action);
  });
  // Prompt drafts: picking a venue candidate (or, with no lookup, a known place)
  // fills the stretch / the outing's place and previews it.
  async function picked(t, pick) {
    const c = opts.prompt?.cards?.[Number(t.dataset.card)];
    if (!c?.draft || !pickVenue(c, t.dataset.slot, pick)) return;
    opts.renderPrompt?.();
    if (!c.draft.status) { await opts.previewCard?.(c); if (ctx.alive()) opts.renderPrompt?.(); }
  }
  ctx.listen(root, 'click', async (e) => {
    const t = e.target.closest?.('.ld-p-venue');
    if (!t || t.disabled || !opts.prompt) return;
    await picked(t, { candidateId: t.dataset.id });
  });
  ctx.listen(root, 'change', async (e) => {
    const t = e.target.closest?.('.ld-p-known');
    if (!t || t.disabled || !opts.prompt || !t.value) return;
    await picked(t, { placeId: t.value });
  });
  // The page's load (and its 30 s poll) calls refresh().
  return { refresh: loadList };
}
