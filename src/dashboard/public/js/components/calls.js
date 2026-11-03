// Phone calls panel for the person and group pages: live call + transcript, CALL
// buttons, and call history. A person page shows its 1:1/inbound calls; a group
// page shows calls placed with that group's context (CALL buttons on member rows).
//
// Live state comes from the shared stream (topic `calls`: snapshot | state |
// partial | line | ended | summary). Every listener, timer and subscription is
// registered on the page ctx, so navigating away (or to another group) drops them
// all — the pre-007 panel left a click handler on #content that fired on the next
// group's page (cleanup F1).
import { api } from '../core/api.js';
import { html, render, $ } from '../core/dom.js';
import { fmtTime, maskPhone, padz } from '../core/fmt.js';
import { flash } from './flash.js';
import { getStatus } from './topbar.js';

const CALL_PILL = { dialing: 'warn', ringing: 'warn', active: 'live', ended: '', missed: 'bad', failed: 'bad', busy: 'bad' };
export const fmtMmSs = (sec) => (sec == null || sec < 0) ? '—' : `${Math.floor(sec / 60)}:${padz(sec % 60)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
/** The bot's name for transcript lines — from status, never a literal. */
export const botName = () => getStatus()?.persona?.displayName || getStatus()?.persona?.name || 'bot';

export function callBelongs(call, scope) {
  if (!call) return false;
  return scope.groupJid ? call.groupJid === scope.groupJid : (call.personJid === scope.personJid && call.context !== 'group');
}

async function placeCall(personJid, groupJid) {
  try {
    await api('/api/calls', { method: 'POST', body: groupJid ? { personJid, groupJid } : { personJid } });
    flash('CALLING…');
  } catch (err) { flash(err.message, 'bad', 6000); }
}

export function transcriptView(lines, partial, theirName) {
  const me = botName();
  const row = (speaker, text, live) => html`<div style="padding:2px 0${live ? ';opacity:0.6;font-style:italic' : ''}"><b class="${speaker === 'bot' ? 'red-bright' : ''}">${speaker === 'bot' ? me : theirName}:</b> ${text}</div>`;
  const out = lines.map((l) => row(l.speaker, l.text, false));
  for (const sp of ['them', 'bot']) if (partial?.[sp]) out.push(row(sp, partial[sp], true));
  return out.length ? out : html`<div class="mute mono">waiting for speech…</div>`;
}

/**
 * Mount the panel into ctx.root's `scope.liveSlot` / `scope.historySlot`.
 * scope: { personJid?, groupJid?, liveSlot, historySlot }
 */
export function mountCalls(ctx, scope) {
  const root = ctx.root;
  const liveEl = $(root, `[data-slot="${scope.liveSlot}"]`);
  const histEl = $(root, `[data-slot="${scope.historySlot}"]`);
  if (!liveEl || !histEl) return;
  let current = null; // active call that belongs to this page
  let other = null;   // active call elsewhere (line busy)
  let lines = [];
  let partial = { them: '', bot: '' };
  let dialable = null;
  let enabled = true;

  ctx.setInterval(() => {
    const d = $(liveEl, '[data-call-dur]');
    if (d && current?.answeredAt) d.textContent = fmtMmSs(nowSec() - current.answeredAt);
  }, 1000);

  const scrollTranscript = () => {
    const t = $(liveEl, '[data-call-transcript]');
    if (t) t.scrollTop = t.scrollHeight;
  };

  const renderLive = () => {
    if (!ctx.alive()) return;
    if (current) {
      const who = current.name || maskPhone(current.phone);
      const context = current.context === 'group' ? `group · ${current.groupName || ''}` : current.context;
      render(liveEl, html`
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="pill ${CALL_PILL[current.status] || ''}">${current.status}</span>
          <b>${who}</b>
          <span class="mono mute">${current.direction === 'inbound' ? '⇠ inbound' : '⇢ outbound'} · ${context} · <span data-call-dur>${current.answeredAt ? fmtMmSs(nowSec() - current.answeredAt) : '—'}</span></span>
          <button type="button" class="danger" data-call-hangup>HANG UP</button>
        </div>
        <div data-call-transcript style="margin-top:8px;max-height:320px;overflow:auto;border:1px solid var(--line-2);padding:6px">${transcriptView(lines, partial, current.name || 'Them')}</div>`);
      scrollTranscript();
      return;
    }
    if (!enabled) { render(liveEl, html`<span class="mute">Calls are off — enable the <b>calls</b> skill in the Skills tab.</span>`); return; }
    if (other) {
      render(liveEl, html`<span class="mute">Line busy — on a call with <b>${other.name || maskPhone(other.phone)}</b>.</span>`);
      return;
    }
    const me = botName();
    if (scope.groupJid) {
      render(liveEl, html`<span class="mute">Use <b>CALL</b> next to a member to ring them; ${me} talks with this group's context.</span>`);
      return;
    }
    render(liveEl, dialable === false
      ? html`<span class="mute">No callable number for this person (unknown or outside the supported region).</span>`
      : html`<button type="button" class="primary" data-call-start>CALL</button> <span class="mute">${me} calls them with your 1:1 chat as context.</span>`);
  };

  const renderTranscriptOnly = () => {
    const t = $(liveEl, '[data-call-transcript]');
    if (!t || !current) return renderLive();
    render(t, transcriptView(lines, partial, current.name || 'Them'));
    scrollTranscript();
  };

  const loadHistory = async () => {
    try {
      const q = scope.groupJid ? `group=${encodeURIComponent(scope.groupJid)}` : `person=${encodeURIComponent(scope.personJid)}`;
      const rows = await api(`/api/calls?${q}`, { signal: ctx.signal });
      if (!ctx.alive()) return;
      render(histEl, rows.length
        ? rows.map((r) => html`
          <tr data-call-row="${r.id}" style="cursor:pointer">
            <td class="id mono">${fmtTime(r.startedAt)}</td>
            <td class="mono">${r.direction === 'inbound' ? '⇠' : '⇢'}</td>
            <td><span class="pill ${CALL_PILL[r.status] || ''}">${r.status}</span></td>
            <td class="mono">${fmtMmSs(r.durationSec)}</td>
            <td class="mute">${(r.summary || r.endReason || '').slice(0, 90)}</td>
          </tr>
          <tr data-call-detail="${r.id}" style="display:none"><td colspan="5"></td></tr>`)
        : html`<tr><td colspan="5" class="empty">NO CALLS YET</td></tr>`);
    } catch (err) {
      if (ctx.alive() && err?.name !== 'AbortError') render(histEl, html`<tr><td colspan="5" class="empty">${err.message}</td></tr>`);
    }
  };

  // One delegated click listener on the page root for everything in the panel.
  ctx.listen(root, 'click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-call-hangup]')) {
      try { await api('/api/calls/hangup', { method: 'POST' }); } catch (err) { flash(err.message, 'bad'); }
      return;
    }
    const start = t.closest('[data-call-start]');
    if (start && liveEl.contains(start)) {
      start.disabled = true;
      placeCall(scope.personJid, null).finally(() => { start.disabled = false; });
      return;
    }
    const member = scope.groupJid ? t.closest('[data-call-member]') : null;
    if (member) {
      member.disabled = true;
      placeCall(member.getAttribute('data-call-member'), scope.groupJid).finally(() => { member.disabled = false; });
      return;
    }
    const tr = t.closest('[data-call-row]');
    if (!tr || !histEl.contains(tr)) return;
    const id = tr.getAttribute('data-call-row');
    const detail = $(histEl, `[data-call-detail="${id}"]`);
    if (!detail) return;
    if (detail.style.display !== 'none') { detail.style.display = 'none'; return; }
    detail.style.display = '';
    const cell = detail.firstElementChild;
    render(cell, html`<span class="mute mono">loading…</span>`);
    try {
      const c = await api(`/api/calls/${encodeURIComponent(id)}`, { signal: ctx.signal });
      if (!ctx.alive()) return;
      render(cell, html`${c.summary ? html`<div style="margin-bottom:6px"><b class="cap mute">SUMMARY</b> ${c.summary}</div>` : ''}
        <div style="max-height:300px;overflow:auto">${transcriptView(c.transcript || [], null, 'Them')}</div>
        <div class="mono mute" style="margin-top:4px">${c.context} · ${c.endReason || ''}</div>`);
    } catch (err) { if (ctx.alive()) cell.textContent = err.message; }
  });

  const adopt = async (call) => {
    if (callBelongs(call, scope)) {
      const fresh = !current || current.id !== call.id;
      current = call;
      other = null;
      if (fresh) {
        lines = [];
        partial = { ...(call.partial || { them: '', bot: '' }) };
        try { lines = (await api(`/api/calls/${encodeURIComponent(call.id)}`, { signal: ctx.signal })).transcript || []; } catch {}
      }
    } else {
      other = call;
    }
    renderLive();
  };

  ctx.on('calls', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'snapshot') {
      enabled = ev.enabled;
      if (ev.active) adopt(ev.active); else renderLive();
      return;
    }
    const mine = current && ev.callId === current.id;
    if (ev.kind === 'state') { adopt(ev.call); return; }
    if (ev.kind === 'partial' && mine) { partial[ev.speaker] = ev.text; renderTranscriptOnly(); return; }
    if (ev.kind === 'line' && mine) { lines.push({ speaker: ev.speaker, text: ev.text }); partial[ev.speaker] = ''; renderTranscriptOnly(); return; }
    if (ev.kind === 'ended') {
      if (mine) { current = null; lines = []; partial = { them: '', bot: '' }; }
      if (other?.id === ev.callId) other = null;
      renderLive();
      ctx.setTimeout(loadHistory, 400);
      return;
    }
    if (ev.kind === 'summary') loadHistory();
  });

  if (scope.personJid && !scope.groupJid) {
    api(`/api/calls/dialable/${encodeURIComponent(scope.personJid)}`, { signal: ctx.signal })
      .then((r) => { dialable = r.dialable; if (!current && !other) renderLive(); })
      .catch(() => {});
  }
  renderLive();
  loadHistory();
}
