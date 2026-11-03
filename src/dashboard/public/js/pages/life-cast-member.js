// LIFE · PEOPLE MEMBER (spec 010 T022, director-api §7) — one person of his cast:
// who they are (relation, age, status, how they speak), their closeness /
// trust / tension now and over time (an SVG polyline from relationship.changed,
// with how far trust moved over the last 7 and 30 days — trust is earned: kept
// plans, backing out, family occasions, breakups, tension, steady contact),
// their history, and the events about them (paged, newest first). Each event
// has WHY (the cause chain from /api/life/events/:id/explain) and NARRATE (a
// short prose explanation, 2/min; needs write mode). Polls every 30 s.
// 016: HISTORY WITH HIM lists the scenes of their outings together (newest
// first: when, where, how it ended, the highlight); READ THE SCENE opens the
// shared HOW IT WENT panel (components/scene-panel.js) with REGENERATE / EDIT
// TEXT / REVERT THIS CHANGE in write mode.
// 019: TEXTS shows the last few texts with them (GET /api/arcs/phone/:castId) and
// links to the whole thread on Life · Phone.
// Every string reaches the DOM through html`` (escaped).
import { api, isAbort } from '../core/api.js';
import { html, render, setSlot, setSlots, $ } from '../core/dom.js';
import { fmtTime, fmtHm, fmtWhen } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { openSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';
import { fold, initFolds } from '../components/views.js';
import { readOnly } from './life-now.js';
import { mountScenePanel, endingWord } from '../components/scene-panel.js';
import { arcsStatus, arcsOffNote, avatar, metricBars, lineChart, awayText, upper, fx, finite } from './life-cast.js';
import { bubble, phoneHref } from './life-phone.js';

const TEXTS_SHOWN = 5;

const POLL_MS = 30_000;
const PAGE = 50;
const IDENTITY = [['relation', 'RELATION'], ['label', 'LABEL'], ['age', 'AGE'], ['pronouns', 'PRONOUNS'], ['job', 'JOB'], ['employer', 'EMPLOYER'],
  ['status', 'STATUS'], ['availability', 'AVAILABILITY'], ['personality', 'PERSONALITY'], ['speech', 'SPEECH'], ['hometown', 'HOMETOWN'], ['birthday', 'BIRTHDAY'], ['metVia', 'MET VIA']];

// A phone leads with how things stand, their texts and the time they've spent together; the
// reference panels fold away there and stay open on desktop.
const shell = (wide) => html`
<div class="page-header">
  <div>
    <div class="crumb"><a href="#life/cast">LIFE · PEOPLE</a> · ONE PERSON</div>
    <h1 class="story-member-title"><span data-slot="lm-avatar"></span> <span data-slot="lm-name">—</span></h1>
  </div>
  <div class="meta">
    <span>ID <b class="mono" data-slot="lm-id">—</b></span>
    <span>PINNED <b data-slot="lm-pinned">—</b></span>
  </div>
</div>
<div data-slot="lm-off"></div>
<div class="lm-grid">
  <div class="lm-col">
    <div class="panel">
      <div class="panel-head"><span>NOW<button type="button" class="guide-q" data-guide="now" aria-label="Guide: now">?</button></span><span class="mono mute" data-slot="lm-romance"></span></div>
      <div class="panel-body" data-slot="lm-metrics"></div>
      <div class="panel-body lm-status" data-slot="lm-status"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>HOW THINGS STAND<button type="button" class="guide-q" data-guide="standing" aria-label="Guide: how things stand">?</button></span><span class="mono mute" data-slot="lm-standing-note"></span></div>
      <div class="panel-body" data-slot="lm-standing"><div class="empty">NO NOTE YET</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>TEXTS<button type="button" class="guide-q" data-guide="texts" aria-label="Guide: texts">?</button></span><span data-slot="lm-phone-link"></span></div>
      <div class="panel-body lp-mini" data-slot="lm-phone"><div class="empty">NO TEXTS YET</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>HISTORY WITH HIM<button type="button" class="guide-q" data-guide="scenes" aria-label="Guide: scenes">?</button></span><span class="mono mute">HOW THEIR OUTINGS WENT</span></div>
      <div class="panel-body" data-slot="lm-scenes"><div class="empty">NO SCENES YET</div></div>
    </div>
  </div>
  <div class="lm-col">
    ${fold({ id: 'member.who', open: wide, title: html`WHO<button type="button" class="guide-q" data-guide="who" aria-label="Guide: who">?</button>`, meta: 'WORLD + STORY OVERLAY', body: html`<div class="panel-body" data-slot="lm-identity"><div class="loading">LOADING</div></div>` })}
    ${fold({ id: 'member.time', open: wide, title: html`OVER TIME<button type="button" class="guide-q" data-guide="over-time" aria-label="Guide: over-time">?</button>`, meta: 'FROM THE LOG', body: html`<div class="panel-body" data-slot="lm-chart"></div><div class="panel-body mono mute" data-slot="lm-trust"></div>` })}
    ${fold({ id: 'member.history', open: wide, title: html`HISTORY<button type="button" class="guide-q" data-guide="history" aria-label="Guide: history">?</button>`, meta: 'SHARED PAST', body: html`<div class="panel-body" data-slot="lm-history"></div>` })}
    ${fold({ id: 'member.events', open: wide, title: html`EVENTS<button type="button" class="guide-q" data-guide="events" aria-label="Guide: events">?</button>`, meta: 'NEWEST FIRST', body: html`<div class="table-wrap"><table class="data">
        <thead><tr><th>#</th><th>WHEN</th><th>WHAT</th><th>BY</th><th>ORIGIN</th><th></th></tr></thead>
        <tbody data-slot="lm-events"></tbody>
      </table></div>
      <div class="panel-body"><button type="button" id="lmOlder" hidden>OLDER</button></div>` })}
  </div>
</div>`;

function identityView(m) {
  const rows = IDENTITY.filter(([k]) => m[k] !== undefined && m[k] !== null && m[k] !== '');
  if (!rows.length) return html`<div class="empty">NO DETAILS</div>`;
  return html`<dl class="story-dl">${rows.map(([k, lab]) => html`<dt>${lab}</dt><dd>${typeof m[k] === 'object' ? JSON.stringify(m[k]) : m[k]}</dd>`)}</dl>
    ${m.away ? html`<div><span class="chip">AWAY</span> <span class="mono mute">${awayText(m.away, fmtTime)}</span></div>` : ''}`;
}

// Trust now minus trust at the last point at least `days` ago (null without one).
function trustMove(series, days) {
  const pts = series.filter((p) => finite(p?.at) && finite(p?.trust));
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const past = pts.filter((p) => p.at <= last.at - days * 86400).pop() ?? pts[0];
  return Math.round((last.trust - past.trust) * 1000) / 1000;
}

function trustView(series) {
  const sign = (v) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fx(Math.abs(v))}`);
  return html`TRUST MOVED <b>${sign(trustMove(series, 7))}</b> IN 7 DAYS · <b>${sign(trustMove(series, 30))}</b> IN 30 DAYS`;
}

function historyView(list) {
  if (!list.length) return html`<div class="empty">NO HISTORY YET</div>`;
  return html`<ul class="story-list">${list.map((h) => (typeof h === 'string'
    ? html`<li>${h}</li>`
    : html`<li>${h.text || h.summary || ''} <span class="mono mute">${h.dated || h.at ? fmtTime(h.dated || h.at) : ''}${h.source ? ` · ${h.source}` : ''}</span></li>`))}</ul>`;
}

/** 019: the last few texts with them as small bubbles (read only here). */
export function textsView(messages) {
  const list = Array.isArray(messages) ? messages.slice(-TEXTS_SHOWN) : [];
  if (!list.length) return html`<div class="empty">NO TEXTS YET</div>`;
  return html`<div class="lp-msgs">${list.map((m) => bubble(m, { ro: true }))}</div>`;
}

/** 016: the scenes of their outings together, newest first, each with READ THE SCENE. */
export function scenesView(list) {
  if (!Array.isArray(list) || !list.length) return html`<div class="empty">NO SCENES YET · AN OUTING TOGETHER GETS ONE WHEN IT ENDS</div>`;
  return html`<ul class="story-list scene-history">${list.map((x) => html`<li class="${x.excluded ? 'is-reverted' : ''}">
    <div class="mono mute">${x.at ? fmtTime(x.at) : '—'}${x.place ? ` · ${String(x.place).toUpperCase()}` : ''}${x.firstMeet ? ' · FIRST MEETING' : ''}</div>
    <div>${x.highlight || 'No highlight.'}</div>
    <div>${x.ending ? html`<span class="chip">${endingWord(x.ending)}</span> ` : ''}${typeof x.chemistry === 'number' && Number.isFinite(x.chemistry) ? html`<span class="chip">CHEMISTRY ${x.chemistry.toFixed(2)}</span> ` : ''}${x.excluded ? html`<span class="chip bad">REVERTED</span> ` : ''}
      ${Number.isSafeInteger(x.sceneId) ? html`<button type="button" class="lm-scene" data-scene="${x.sceneId}">READ THE SCENE ›</button>` : ''}</div>
  </li>`)}</ul>`;
}

const STANDING_STATUS = { live: 'NOW', superseded: 'EARLIER', invalidated: 'UNDONE' };
const STANDING_REASON = { evidence_gone: 'what it rested on left his life', built_on_gone: 'built on one that was undone', rewound: 'rewound', heavy_window: 'too near a hard stretch', words_changed: 'its words were edited' };

/** 020 D2: the note on them, and its earlier versions. Every string through html`` (escaped). */
export function standingView(st) {
  if (st && st.enabled === false) return html`<div class="empty">SWITCHED OFF (ARCS_STANDING_ENABLED)</div>`;
  const versions = st?.versions || [];
  const cur = st?.current;
  if (!versions.length) return html`<div class="empty">NO NOTE YET · WRITTEN AT NIGHT ONCE SOMETHING HAPPENS BETWEEN THEM</div>`;
  const older = versions.filter((v) => v.status !== 'live');
  return html`${cur ? html`<p class="lm-standing-now">${cur.text}</p>` : html`<div class="empty">UNDONE · REBUILT AT NIGHT · THE WRITERS USE THE HISTORY UNTIL THEN</div>`}
    ${older.length ? html`<details class="subfold m-older lm-standing-older"><summary class="mono">EARLIER VERSIONS · ${older.length}</summary>
      <ul class="lm-history">${older.map((v) => html`<li>
        <span class="chip">${STANDING_STATUS[v.status] ?? v.status}</span>
        <span class="mono mute">${fmtWhen(v.validFrom)}${v.validTo ? html` – ${fmtWhen(v.validTo)}` : ''}${v.reason ? html` · ${STANDING_REASON[v.reason] ?? v.reason}` : ''}</span>
        <div>${v.text}</div>
      </li>`)}</ul></details>` : ''}`;
}

/** The panel's header note: when it was written and what it rests on. */
export function standingNote(st) {
  const c = st?.current;
  if (!c || st.enabled === false) return '';   // switched off, the panel says so: no "as of" beside it
  return `AS OF ${fmtWhen(c.asOfAt ?? c.validFrom)} · ${c.evidenceCount} EVENT${c.evidenceCount === 1 ? '' : 'S'}`;
}

function eventRow(e, ro) {
  return html`<tr class="${e.excluded ? 'is-reverted' : ''}">
    <td class="id">${e.id}</td><td class="mono">${fmtTime(e.at)}</td>
    <td>${e.type}${e.excluded ? html` <span class="chip" title="reverted or rewound: no longer part of his world">REVERTED</span>` : ''}${e.summary ? html`<div class="mute">${e.summary}</div>` : ''}</td>
    <td><span class="chip">${e.actor}</span></td>
    <td><span class="chip ${e.origin === 'dm' || e.origin === 'call' ? 'warn' : ''}">${e.origin || '—'}</span></td>
    <td><button type="button" class="lm-why" data-id="${e.id}">WHY</button>
      <button type="button" class="lm-narrate" data-id="${e.id}" ${ro ? 'disabled' : ''}>NARRATE</button></td>
  </tr>`;
}

export async function mount(ctx, castIdParam) {
  const root = ctx.root;
  const castId = String(castIdParam || '');
  render(root, shell(!globalThis.matchMedia?.('(max-width: 900px)').matches));
  initFolds(root);
  let events = [];
  let nextBefore = null;
  let paged = false;

  // A scene, and why an event happened, open in a sheet: nothing long sits under the fold of
  // a phone, and a poll can't touch what you're reading.
  function openScene(sid) {
    const sheet = openSheet({ label: `How it went · scene #${sid}` });
    ctx.onDispose(sheet.close);
    mountScenePanel(ctx, sheet.body, { readOnly, onChanged: () => { load().catch(() => {}); } }).show(sid);
  }
  function openEventSheet(label) {
    const sheet = openSheet({ label, content: html`<div class="loading">LOADING</div>` });
    ctx.onDispose(sheet.close);
    return sheet;
  }

  // 019: the last few texts with them (best effort: a failed or missing phone read leaves a note).
  async function loadTexts() {
    let r = null;
    try {
      r = await api(`/api/arcs/phone/${encodeURIComponent(castId)}?limit=${TEXTS_SHOWN}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      r = null;
    }
    if (!ctx.alive()) return;
    setSlot(root, 'lm-phone-link', html`<a class="mono" href="${phoneHref(castId)}">OPEN THE CHAT ›</a>`);
    setSlot(root, 'lm-phone', textsView(r?.thread?.messages));
  }

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    setSlot(root, 'lm-off', arcsOffNote(st));
    let d;
    try {
      d = await api(`/api/arcs/cast/${encodeURIComponent(castId)}?limit=${PAGE}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err?.status === 404 || err?.status === 400) {
        // Not inside a fold: on a phone that would be a page of closed panels and no reason why.
        setSlot(root, 'lm-off', html`<div class="empty">NO SUCH CAST MEMBER · <a href="#life/cast">ALL PEOPLE</a></div>`);
        return;
      }
      throw err;
    }
    if (!ctx.alive()) return;
    const m = d?.member || {};
    setSlots(root, { 'lm-name': m.name || castId, 'lm-id': castId, 'lm-pinned': m.pinned ? 'YES' : 'NO' });
    setSlot(root, 'lm-avatar', avatar(m.initials, { kind: String(m.relation || '').split(':')[0] }));
    setSlot(root, 'lm-identity', d?.enabled ? identityView(m) : html`<div class="empty">ARCS IS OFF</div>`);
    setSlot(root, 'lm-metrics', metricBars(m.metrics));
    setSlot(root, 'lm-status', m.status || m.away ? html`${m.status || ''}${m.away ? html` <span class="chip">AWAY</span> <span class="mono mute">${awayText(m.away, fmtTime)}</span>` : ''}` : null);
    const r = m.romance;
    setSlots(root, { 'lm-romance': r ? `${upper(r.stage)} · I ${fx(r.intimacy)} · P ${fx(r.passion)} · C ${fx(r.commitment)}${finite(r.togetherH) ? ` · ${Math.round(r.togetherH)} h together` : ''}` : '' });
    setSlot(root, 'lm-chart', lineChart(Array.isArray(d?.metrics) ? d.metrics : []));
    setSlot(root, 'lm-trust', trustView(Array.isArray(d?.metrics) ? d.metrics : []));
    setSlot(root, 'lm-history', historyView(Array.isArray(d?.history) ? d.history : []));
    setSlot(root, 'lm-scenes', scenesView(d?.scenes));
    setSlots(root, { 'lm-standing-note': standingNote(d?.standing) });
    setSlot(root, 'lm-standing', standingView(d?.standing));
    await loadTexts();
    if (!ctx.alive()) return;
    if (!paged) {
      events = Array.isArray(d?.events) ? d.events : [];
      nextBefore = d?.nextBefore ?? null;
      paintEvents();
    }
  }

  function paintEvents() {
    const ro = readOnly();
    setSlot(root, 'lm-events', events.length ? events.map((e) => eventRow(e, ro)) : html`<tr><td colspan="6" class="empty">NO EVENTS</td></tr>`);
    const older = $(root, '#lmOlder');
    if (older) older.hidden = !nextBefore;
  }

  ctx.listen($(root, '#lmOlder'), 'click', async (e) => {
    if (!nextBefore) return;
    e.target.disabled = true;
    try {
      const d = await api(`/api/arcs/cast/${encodeURIComponent(castId)}?limit=${PAGE}&before=${encodeURIComponent(nextBefore)}`, { signal: ctx.signal });
      if (!ctx.alive()) return;
      paged = true;
      const seen = new Set(events.map((x) => x.id));
      events = events.concat((d?.events || []).filter((x) => !seen.has(x.id)));
      nextBefore = d?.nextBefore ?? null;
      paintEvents();
    } catch (err) {
      if (!isAbort(err)) flash(err.message, 'bad');
    } finally {
      if (ctx.alive()) e.target.disabled = false;
    }
  });

  ctx.listen(root, 'click', async (e) => {
    const sc = e.target.closest?.('.lm-scene');
    if (sc) {
      const sid = Number(sc.dataset.scene);
      if (Number.isSafeInteger(sid) && sid > 0) openScene(sid);
      return;
    }
    const why = e.target.closest?.('.lm-why');
    if (why) {
      const sheet = openEventSheet(`Why · event #${why.dataset.id}`);
      try {
        const r = await api(`/api/life/events/${encodeURIComponent(why.dataset.id)}/explain`, { signal: ctx.signal });
        if (!ctx.alive()) return;
        const chain = Array.isArray(r?.chain) ? r.chain : [];
        render(sheet.body, html`<ol class="life-chain">${chain.map((ev) => html`<li class="${String(ev.id) === why.dataset.id ? 'is-target' : ''}">
          <span class="mono">#${ev.id} · ${fmtHm(ev.at)}</span> <b>${ev.type}</b> <span class="chip">${ev.actor}</span> <span class="mono mute">${ev.originKind || ''}</span>
          ${ev.reverted ? html` <span class="chip">REVERTED</span>` : ''}</li>`)}</ol>`);
      } catch (err) {
        if (!isAbort(err) && ctx.alive()) render(sheet.body, html`<div class="red mono">${err.message}</div>`);
      }
      return;
    }
    const nar = e.target.closest?.('.lm-narrate');
    if (nar && !nar.disabled) {
      nar.disabled = true;
      const sheet = openEventSheet(`Narration · event #${nar.dataset.id}`);
      render(sheet.body, html`<div class="loading">NARRATING</div>`);
      try {
        const r = await api('/api/arcs/narrate', { method: 'POST', body: { eventId: Number(nar.dataset.id) } });
        if (ctx.alive()) {
          render(sheet.body, html`<p class="story-diary">${r?.text || ''}</p>
            <div class="mono mute">${(r?.origins || []).map((o) => html`<span class="chip">${o}</span>`)}${r?.cached ? ' · CACHED' : ' · NEW'}</div>`);
        }
      } catch (err) {
        if (!isAbort(err) && ctx.alive()) render(sheet.body, html`<div class="red mono">${err.message}</div>`);
      } finally {
        if (ctx.alive()) nar.disabled = readOnly();
      }
    }
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life cast member poll', err); }); }, POLL_MS);
}
