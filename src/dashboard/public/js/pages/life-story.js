// LIFE · STORY (spec 010 T022, director-api §7) — the arcs board by category
// (romance, career, family, cast, health, social, heavy): the category's fate
// mode, each arc's stage, since when, who is in it, its last beats and its next
// decision (active arcs first, ended ones dimmed with an ENDED chip), and an
// "inert" note when the seed has no section for it. Above it, the
// weekly pass's proposals waiting for the owner (guided categories): APPROVE
// runs the Director preview (proposal.approve; a heavy nomination has no event
// form, so it is reject-only), REJECT is direct. Then FROM
// CHATS (spec 012 P3): advice someone gave him in a chat, waiting for the owner —
// APPROVE opens the Director with its scene form preset to that category (nothing
// changes until a scene is applied there), REJECT drops it. A panel with nothing
// waiting moves under the board, and an empty category is one line.
// Polls every 30 s. Every string reaches the DOM through html`` (escaped).
import { api, isAbort } from '../core/api.js';
import { html, render, slotPainter, setSlots } from '../core/dom.js';
import { fmtTime, fmtRelative, fmtHm } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { showError } from '../components/ui.js';
import { readOnly } from './life-now.js';
import { arcsStatus, arcsOffNote, castHref, upper } from './life-cast.js';
import { openPreview, adviceTable, queueScenePreset } from './life-director.js';

const POLL_MS = 30_000;
const PAYLOAD_MAX = 240;

const INERT = {
  no_seed_section: 'inert: the arc seed has no section for this category',
  no_appraisal_month: 'inert: no appraisal month in the seed',
  no_family_cast: 'inert: nobody in his cast is family (no family:* relation)',
};

const SHELL = html`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · STORY · ARCS BY CATEGORY</div>
    <h1>Story</h1>
  </div>
  <div class="meta">
    <span>ACTIVE ARCS <b data-slot="ls-active">—</b></span>
    <span>STORY <b data-slot="ls-paused">—</b></span>
    <span>PROPOSALS <b class="amber" data-slot="ls-props">—</b></span>
  </div>
</div>
<div data-slot="ls-off"></div>
<div class="ls-page">
<div class="panel ls-wait" data-wait="proposals">
  <div class="panel-head"><span>PROPOSALS AWAITING APPROVAL<button type="button" class="guide-q" data-guide="proposals" aria-label="Guide: proposals">?</button></span><span class="mono mute">FROM THE WEEKLY PASS · GUIDED CATEGORIES</span></div>
  <div data-slot="ls-proposals"></div>
</div>
<div class="panel ls-wait" data-wait="advice">
  <div class="panel-head"><span>FROM CHATS · ADVICE ABOUT HIS LIFE<button type="button" class="guide-q" data-guide="fromchats" aria-label="Guide: from chats">?</button></span><span class="mono mute">APPROVE = OPEN THE DIRECTOR · NOTHING CHANGES ON ITS OWN</span></div>
  <div data-slot="ls-advice"></div>
</div>
<div class="story-board" data-slot="ls-board"><div class="loading">LOADING</div></div>
</div>`;

const FATE_CLASS = { natural: 'ok', guided: 'warn', frozen: 'bad' };

function beatLine(b) {
  if (b == null) return null;
  if (typeof b === 'string') return html`<li>${b}</li>`;
  return html`<li><span class="mono mute">${b.at ? fmtRelative(b.at) + ' ago' : ''}</span> ${b.summary || b.text || b.type || ''}</li>`;
}

function arcCard(a, castName) {
  const nd = a.nextDecision;
  const ended = a.status && a.status !== 'active';
  return html`<div class="story-arc ${ended ? 'is-ended' : ''}">
    <div><b>${upper(a.kind)}</b> <span class="chip">${upper(a.stage)}</span>${ended ? html` <span class="chip bad">${a.status === 'ended' ? 'ENDED' : upper(a.status)}${a.outcome ? ` · ${upper(a.outcome)}` : ''}</span>` : ''}
      <span class="mono mute">#${a.id}${ended && a.endedAt ? ` · ended ${fmtTime(a.endedAt)}` : a.since ? ` · since ${fmtTime(a.since)}` : ''}</span></div>
    ${(a.castIds || []).length ? html`<div class="mono">${a.castIds.map((id, i) => html`${i ? ', ' : ''}<a href="${castHref(id)}">${castName(id)}</a>`)}</div>` : ''}
    ${(a.lastBeats || []).length ? html`<ul class="story-list">${a.lastBeats.slice(0, 3).map(beatLine)}</ul>` : ''}
    ${nd ? html`<div class="mono amber">NEXT · ${upper(nd.kind)}${nd.decideBy ? ` · decide by ${fmtHm(nd.decideBy)}` : ''}${nd.mode === 'ask' ? ' · ASK ME' : ''} <a href="#life/pending">→ PENDING</a></div>` : ''}
  </div>`;
}

function categoryPanel(c, castName) {
  const arcs = Array.isArray(c.arcs) ? c.arcs : [];
  const fate = html`<span class="chip ${FATE_CLASS[c.fate] || ''}">${upper(c.fate || 'natural')}</span>`;
  // Nothing in it and nothing to say: a line, not a box.
  if (!arcs.length && !c.nextDecision && !c.inert) {
    return html`<div class="panel story-cat is-quiet"><div class="panel-head"><span>${upper(c.category)}</span><span class="story-cat-quiet"><span class="mono mute">NO ARC</span>${fate}</span></div></div>`;
  }
  return html`<div class="panel story-cat">
    <div class="panel-head"><span>${upper(c.category)}</span>${fate}</div>
    <div class="panel-body">
      ${c.inert ? html`<div class="mono mute story-inert">${INERT[c.inert] || `inert: ${c.inert}`}</div>` : ''}
      ${arcs.length ? arcs.map((a) => arcCard(a, castName)) : c.inert ? '' : html`<div class="empty">NO ARC</div>`}
      ${c.nextDecision ? html`<div class="mono amber">NEXT · ${upper(c.nextDecision.kind)}${c.nextDecision.decideBy ? ` · ${fmtHm(c.nextDecision.decideBy)}` : ''}</div>` : ''}
    </div>
  </div>`;
}

function shortJson(v) {
  let s;
  try { s = JSON.stringify(v); } catch { s = ''; }
  return s && s.length > PAYLOAD_MAX ? `${s.slice(0, PAYLOAD_MAX)}…` : s || '';
}

const word = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const OPENER_WORDS = {
  romance_interest: 'A romantic interest', social_plan: 'A plan to go out', cast_meetup: 'A meetup',
  family_visit: 'A family visit', career_hunt: 'Looking for a new job',
};

/**
 * What a proposal would do, in words built here from its payload (the store keeps no summary).
 * null when the kind or its fields aren't known: the page then shows only DETAILS.
 */
export function proposalLine(p, castName = (id) => id) {
  const x = p?.payload && typeof p.payload === 'object' ? p.payload : {};
  const who = word(x.castId) ? castName(x.castId) : null;
  switch (p?.kind) {
    case 'beat': return who && word(x.text) ? `${who}: ${word(x.text)}` : null;
    case 'new_cast': return word(x.name) ? `Someone new: ${word(x.name)}${word(x.relation) ? `, ${word(x.relation)}` : ''}` : null;
    case 'new_place': return word(x.name) ? `A new place: ${word(x.name)}${word(x.kind) ? `, ${word(x.kind)}` : ''}` : null;
    case 'arc_decision': return OPENER_WORDS[x.kind] ? `${OPENER_WORDS[x.kind]}${who ? ` with ${who}` : ''}` : null;
    case 'heavy_nomination': return word(x.themeId) ? `Weights the next hard stretch towards: ${word(x.themeId)}` : null;
    default: return null;
  }
}

function proposalWhat(p, castName) {
  const line = word(p.summary) || proposalLine(p, castName);
  const json = shortJson(p.payload);
  const details = json && json !== '{}' && json !== 'null' ? json : null;
  if (!line && !details) return html`<span class="mute">—</span>`;
  return html`${line ? html`<div>${line}</div>` : ''}${details ? html`<details class="subfold ls-details"><summary class="mono mute">DETAILS</summary><div class="mono story-payload">${details}</div></details>` : ''}`;
}

function proposalRow(p, ro, castName) {
  const pending = p.status === 'pending';
  return html`<tr>
    <td class="id">#${p.id}</td>
    <td>${upper(p.category)}</td>
    <td>${upper(p.kind)}</td>
    <td>${proposalWhat(p, castName)}</td>
    <td class="mono">${p.createdAt ? `${fmtRelative(p.createdAt)} ago` : '—'}</td>
    <td>${pending
      ? html`${p.kind === 'heavy_nomination'
        ? html`<span class="chip" title="A nomination only weights the next heavy roll; it has nothing to apply">REJECT ONLY</span>`
        : html`<button type="button" class="primary ls-approve" data-id="${p.id}" ${ro ? 'disabled' : ''}>PREVIEW APPROVE</button>`}
        <button type="button" class="ls-reject" data-id="${p.id}" ${ro ? 'disabled' : ''}>REJECT</button>`
      : html`<span class="chip">${upper(p.status)}</span>`}</td>
  </tr>`;
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const paintSlot = slotPainter(root);
  const setSlot = (_, key, tpl) => paintSlot(key, tpl);

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    const [board, cast, props, advice] = await Promise.all([
      api('/api/arcs/story', { signal: ctx.signal }),
      api('/api/arcs/cast', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { cast: [] }; }),
      api('/api/arcs/proposals?status=pending&limit=50', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { proposals: [] }; }),
      api('/api/influence/advice?status=pending&limit=50', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return { advice: [] }; }),
    ]);
    if (!ctx.alive()) return;
    const names = new Map((cast?.cast || []).map((c) => [c.id, c.name || c.id]));
    const castName = (id) => names.get(id) || id;
    const cats = Array.isArray(board?.categories) ? board.categories : [];
    const proposals = Array.isArray(props?.proposals) ? props.proposals : [];
    const ro = readOnly();
    setSlot(root, 'ls-off', arcsOffNote(st));
    setSlots(root, {
      'ls-active': cats.reduce((n, c) => n + (Array.isArray(c.arcs) ? c.arcs.filter((a) => a.status === undefined || a.status === 'active').length : 0), 0),
      'ls-paused': st.paused ? 'PAUSED' : st.enabled ? 'RUNNING' : 'OFF',
      'ls-props': proposals.length,
    });
    // Categories with something in them first, in their usual order.
    const hasAny = (c) => (Array.isArray(c.arcs) && c.arcs.length) || c.nextDecision || c.inert;
    const ordered = [...cats.filter(hasAny), ...cats.filter((c) => !hasAny(c))];
    setSlot(root, 'ls-board', ordered.length ? ordered.map((c) => categoryPanel(c, castName))
      : html`<div class="panel"><div class="empty">${board?.enabled ? 'NO ARCS YET' : 'ARCS IS OFF'}</div></div>`);
    setSlot(root, 'ls-proposals', proposals.length
      ? html`<div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>CATEGORY</th><th>KIND</th><th>WHAT</th><th>WHEN</th><th></th></tr></thead>
          <tbody>${proposals.map((p) => proposalRow(p, ro, castName))}</tbody></table></div>`
      : html`<div class="empty">NOTHING WAITING</div>`);
    const adviceRows = Array.isArray(advice?.advice) ? advice.advice : [];
    setSlot(root, 'ls-advice', adviceTable(adviceRows, ro || !st.enabled, 'ls-advice'));
    // What waits comes before the board; a panel with nothing in it goes under it.
    root.querySelector('[data-wait="proposals"]')?.classList.toggle('is-idle', !proposals.length);
    root.querySelector('[data-wait="advice"]')?.classList.toggle('is-idle', !adviceRows.length);
  }

  ctx.listen(root, 'click', async (e) => {
    const approve = e.target.closest?.('.ls-approve');
    if (approve && !approve.disabled) {
      openPreview(ctx, { kind: 'proposal.approve', proposalId: Number(approve.dataset.id) }, { title: `APPROVE PROPOSAL #${approve.dataset.id}`, onApplied: () => load().catch(() => {}) });
      return;
    }
    const adv = e.target.closest?.('.ls-advice-approve, .ls-advice-reject');
    if (adv && !adv.disabled) {
      const approving = adv.classList.contains('ls-advice-approve');
      adv.disabled = true;
      try {
        const r = await api(`/api/influence/advice/${encodeURIComponent(adv.dataset.id)}/${approving ? 'approve' : 'reject'}`, { method: 'POST', body: {} });
        flash(`SUGGESTION ${adv.dataset.id} ${approving ? 'APPROVED' : 'REJECTED'}`);
        if (approving && r?.preset && ctx.alive()) {
          queueScenePreset(r.preset);
          location.hash = '#life/director';
          return;
        }
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
        adv.disabled = false;   // a poll with nothing new doesn't repaint it
      }
      if (ctx.alive()) load().catch(() => {});
      return;
    }
    const reject = e.target.closest?.('.ls-reject');
    if (reject && !reject.disabled) {
      reject.disabled = true;
      try {
        await api(`/api/arcs/proposals/${encodeURIComponent(reject.dataset.id)}/reject`, { method: 'POST', body: {} });
        flash(`PROPOSAL ${reject.dataset.id} REJECTED`);
      } catch (err) {
        if (!isAbort(err)) flash(err.message, 'bad');
        reject.disabled = false;   // a poll with nothing new doesn't repaint it
      }
      if (ctx.alive()) load().catch(() => {});
    }
  });

  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch((err) => { if (!isAbort(err)) console.warn('life story poll', err); }); }, POLL_MS);
}
