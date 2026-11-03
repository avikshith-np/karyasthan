// LIFE · PHONE (spec 019) — his texts with the people in his world: a list of
// threads (one per cast member: name, the last message, when) and a thread as
// chat bubbles (his on the right, theirs on the left) with day separators,
// times and EDITED / REVERTED marks. #life/phone/<castId> opens a thread, at its newest
// message; on a phone the list and the thread are two screens (‹ ALL CHATS goes back).
// Reads GET /api/arcs/phone and /api/arcs/phone/:castId (LOAD OLDER pages with
// ?before=<the oldest message's time>). Tap a message for its actions: EDIT
// (≤ 300 characters, PUT …/messages/:id/text), REWRITE (one model call, POST
// …/messages/:id/regenerate) and REVERT (the life revert route on its eventId:
// the message and what it caused leave his world). SEND A TEXT opens its form in a sheet (a
// poll can't wipe what you're typing; a draft survives a cancelled preview) and is the Director
// kind `text` {castId, gist, tone?, from?, words?, chat?} through the shared preview modal
// (life-director.js openPreview): nothing is written before APPLY. WHO TEXTS FIRST: him or
// them; their exact first words (optional, verbatim); a short or a long chat. When they text
// first while he is asleep, the preview says their text wakes him (the Director adds it).

// Only his fictional cast has threads; real chats and real people never do.
// Writes need DASHBOARD_READONLY=false + CSRF (audited, rate-limited). Polls
// every 30 s; every string reaches the DOM through html``.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlot, setSlots, $ } from '../core/dom.js';
import { fmtHm, fmtDay, fmtWhen } from '../core/fmt.js';
import { flash } from '../components/flash.js';
import { askSheet, openSheet } from '../components/sheet.js';
import { showError } from '../components/ui.js';
import { readOnly } from './life-now.js';
import { arcsStatus, arcsOffNote, castHref } from './life-cast.js';
import { openPreview } from './life-director.js';

const POLL_MS = 30_000;
const PAGE = 50;
export const TEXT_MAX = 300;
const GIST_MAX = 200;
const TONE_MAX = 40;
const WORDS_MAX = 160;
const REASON_MAX = 200;
export const CAST_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;

export const phoneHref = (castId) => (castId ? `#life/phone/${encodeURIComponent(castId)}` : '#life/phone');
/** "Tue 3 Nov" — fmtWhen without its time. */
export const dayWords = (at) => fmtWhen(at).replace(/\s\d{1,2}:\d{2}$/, '');

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · PHONE · HIS TEXTS WITH THE PEOPLE IN HIS WORLD</div>
    <h1>Phone</h1>
  </div>
  <div class="meta"><span>CHATS <b data-slot="lp-count">—</b></span></div>
</div>
<div data-slot="lp-off"></div>
<div class="lp-wrap">
  <div class="panel lp-list">
    <div class="panel-head"><span>CHATS<button type="button" class="guide-q" data-guide="threads" aria-label="Guide: chats">?</button></span><span class="mono mute">NEWEST FIRST</span></div>
    <div data-slot="lp-threads"><div class="loading">LOADING</div></div>
  </div>
  <div class="panel lp-thread">
    <div class="panel-head lp-thread-head" data-slot="lp-head"><span>PICK A CHAT</span></div>
    <div class="lp-msgs" data-slot="lp-msgs"><div class="empty">PICK A CHAT ON THE LEFT</div></div>
    <div class="lp-sendbar" data-slot="lp-send"></div>
  </div>
</div>
`);

/** One row of the chat list. */
export function threadRow(t, current) {
  const last = t.last;
  const who = last ? (last.dir === 'in' ? `${t.name}: ` : 'him: ') : '';
  return html`<a class="lp-trow${t.castId === current ? ' is-on' : ''}${t.departed ? ' is-departed' : ''}" href="${phoneHref(t.castId)}">
    <span class="lp-tname">${t.name || t.castId}${t.departed ? html` <span class="chip">LEFT</span>` : ''}</span>
    <span class="lp-twhen mono">${last?.at ? fmtWhen(last.at) : ''}</span>
    <span class="lp-tlast">${last ? html`<span class="mute">${who}</span>${last.preview}` : html`<span class="mute">no texts yet</span>`}</span>
  </a>`;
}

export function threadList(threads, current) {
  if (!threads.length) return html`<div class="empty">NO TEXTS YET · HE TEXTS THE PEOPLE IN HIS WORLD ON HIS OWN, OR YOU CAN SEND ONE</div>`;
  return html`<nav class="lp-tlist" aria-label="Chats">${threads.map((t) => threadRow(t, current))}</nav>`;
}

/** One bubble (his on the right); tapping it shows its actions. */
export function bubble(m, { sel = false, editing = false, ro = true } = {}) {
  const live = m.status !== 'reverted';
  const cls = ['lp-msg', m.dir === 'in' ? 'is-in' : 'is-out', live ? '' : 'is-reverted', sel ? 'is-sel' : ''].filter(Boolean).join(' ');
  const marks = html`${m.edited ? html`<span class="lp-mark">EDITED</span>` : ''}${live ? '' : html`<span class="lp-mark">REVERTED</span>`}`;
  const body = editing
    ? html`<form class="lp-edit" data-edit="${m.id}">
        <textarea name="text" maxlength="${TEXT_MAX}" rows="3" aria-label="Edit the message">${m.text}</textarea>
        <div class="lp-acts"><span class="mono mute">≤ ${TEXT_MAX}</span><button type="submit" class="primary">SAVE</button><button type="button" data-act="cancel">CANCEL</button></div>
      </form>`
    : html`<div class="lp-text">${m.text}</div>`;
  const acts = sel && !editing
    ? html`<div class="lp-acts">
        <button type="button" data-act="edit" data-id="${m.id}" ${ro || !live ? 'disabled' : ''}>EDIT</button>
        <button type="button" data-act="regen" data-id="${m.id}" ${ro || !live || !m.regenerable ? 'disabled' : ''}>REWRITE</button>
        <button type="button" data-act="revert" data-ev="${m.eventId ?? ''}" ${ro || !live || !m.revertible || !m.eventId ? 'disabled' : ''}>REVERT</button>
      </div>`
    : '';
  return html`<div class="lp-row ${m.dir === 'in' ? 'is-in' : 'is-out'}">
    <div class="${cls}" data-msg="${m.id}" role="button" tabindex="0" aria-pressed="${sel ? 'true' : 'false'}">
      ${body}
      <div class="lp-meta mono">${fmtHm(m.at)} ${marks}</div>
    </div>
    ${acts}
  </div>`;
}

/** The thread: day separators, bubbles oldest → newest. */
export function messagesView(messages, { sel = null, editing = null, ro = true, more = false } = {}) {
  if (!messages.length) return html`<div class="empty">NO TEXTS IN THIS CHAT YET</div>`;
  const out = [];
  if (more) out.push(html`<button type="button" class="lp-older" data-act="older">LOAD OLDER</button>`);
  let day = '';
  for (const m of messages) {
    const k = fmtDay(m.at);
    if (k !== day) { day = k; out.push(html`<div class="lp-day mono" role="separator">${dayWords(m.at)}</div>`); }
    out.push(bubble(m, { sel: sel === m.id, editing: editing === m.id, ro }));
  }
  return html`${out}`;
}

/** The form → the Director `text` action (null when there is neither a gist nor words). fd: FormData-like (get). */
export function sendAction(castId, fd) {
  const val = (k, max) => String(fd.get(k) || '').trim().slice(0, max);
  const gist = val('gist', GIST_MAX);
  const words = val('words', WORDS_MAX);
  const t0 = val('tone', TONE_MAX).toLowerCase();
  const tone = TEXT_TONES.includes(t0) ? t0 : '';
  if (!gist && !words) return null;
  const from = fd.get('from') === 'them' ? 'them' : 'him';
  return { kind: 'text', castId, ...(gist ? { gist } : {}), ...(words ? { words } : {}), ...(tone ? { tone } : {}),
    ...(from === 'them' ? { from } : {}), ...(fd.get('chat') === 'long' ? { chat: 'long' } : {}) };
}

// The Director's text tones (director.js TEXT_TONES; test:dashboard keeps the two lists equal).
// A closed list: a free-typed tone was refused bad_tone (2026-11-01 live).
export const TEXT_TONES = Object.freeze(['friendly', 'warm', 'flirty', 'teasing', 'caring', 'excited', 'apologetic', 'casual', 'logistics', 'annoyed', 'naughty']);

export function sendForm(thread, ro) {
  const off = ro || thread.departed;
  const name = thread.name || 'them';
  return html`<form class="lp-sendform" data-send="1">
    <fieldset class="lp-who" ${off ? 'disabled' : ''}><legend class="mono mute">WHO TEXTS FIRST</legend>
      <label><input type="radio" name="from" value="him" checked> he does</label>
      <label><input type="radio" name="from" value="them"> ${name} does</label>
    </fieldset>
    <input name="gist" maxlength="${GIST_MAX}" placeholder="What it's about (e.g. ${name} can't sleep, felt a spark)" aria-label="What the text is about" ${off ? 'disabled' : ''}>
    <input name="words" maxlength="${WORDS_MAX}" placeholder="Exact first text (optional)" aria-label="Exact first text (optional)" ${off ? 'disabled' : ''}>
    <select name="tone" aria-label="Tone (optional)" ${off ? 'disabled' : ''}><option value="">tone (optional)</option>${TEXT_TONES.map((t) => html`<option value="${t}">${t}</option>`)}</select>
    <label class="lp-long"><input type="checkbox" name="chat" value="long" ${off ? 'disabled' : ''}> a long chat</label>
    <button type="submit" class="primary" ${off ? 'disabled' : ''}>SEND A TEXT</button>
    <span class="mono mute lp-sendnote">If ${name} texts first while he's asleep, the text wakes him.</span>
    ${thread.departed ? html`<span class="mono mute">${thread.name} has left his life · read only</span>` : ''}
  </form>`;
}

/** Under the thread: the way to send, and what to do when there's more below. */
export function sendBar(thread, ro, newCount = 0) {
  return html`${newCount ? html`<button type="button" class="lp-new" data-act="to-end">↓ ${newCount} NEW</button>` : ''}
    ${thread.departed ? html`<span class="mono mute lp-left">${thread.name} has left his life · read only</span>` : html`<button type="button" class="primary lp-compose" data-write data-act="compose" ${ro ? 'disabled' : ''}>SEND A TEXT</button>`}`;
}

const DRAFT_KEYS = ['from', 'gist', 'words', 'tone', 'chat'];
const readDraft = (form) => {
  const fd = new FormData(form);
  return Object.fromEntries(DRAFT_KEYS.map((k) => [k, fd.get(k)]));
};
function fillDraft(form, draft) {
  if (!draft) return;
  for (const el of form.elements) {
    if (!DRAFT_KEYS.includes(el.name)) continue;
    if (el.type === 'radio') el.checked = el.value === draft[el.name];
    else if (el.type === 'checkbox') el.checked = !!draft[el.name];
    else el.value = draft[el.name] ?? '';
  }
}

const merge = (older, newer) => {
  const byId = new Map();
  for (const m of [...older, ...newer]) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id - b.id);
};

export async function mount(ctx, castParam) {
  const root = ctx.root;
  render(root, SHELL);
  const castId = CAST_RE.test(String(castParam || '')) ? String(castParam) : null;
  let threads = [];
  let thread = null;
  let messages = [];
  let more = false;
  let sel = null;
  let editing = null;
  let draft = null;     // what's typed in SEND A TEXT, until it's applied
  let newCount = 0;     // arrived while reading further up
  let painted = '';     // what's on screen, so a poll with nothing new touches nothing
  let opened = false;   // the first paint lands on the newest message
  let keepFromEnd = null; // LOAD OLDER: the same message stays in place

  const wrap = $(root, '.lp-wrap');
  if (wrap && castId) wrap.classList.add('has-thread');

  // A phone scrolls the page; desktop scrolls the thread's own pane.
  const scroller = () => (globalThis.matchMedia?.('(max-width: 900px)').matches ? document.scrollingElement : $(root, '.lp-msgs'));
  const nearEnd = (el) => !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const toEnd = () => { const el = scroller(); if (el) el.scrollTop = el.scrollHeight; };

  function paintThread() {
    if (!castId) return;
    if (!thread) {
      setSlot(root, 'lp-head', html`<a class="lp-back" href="#life/phone">‹ ALL CHATS</a><span>NO SUCH CHAT</span>`);
      setSlot(root, 'lp-send', '');
      setSlot(root, 'lp-msgs', html`<div class="empty">NO THREAD FOR ${castId}</div>`);
      return;
    }
    const ro = readOnly();
    const sig = JSON.stringify([thread.name, thread.departed, messages, sel, editing, more, ro, newCount]);
    if (sig === painted) return;
    const before = painted ? JSON.parse(painted)[2].length : 0;
    painted = sig;
    const el = scroller();
    const stick = !opened || nearEnd(el);
    const fromEnd = keepFromEnd && el ? el.scrollHeight - el.scrollTop : null;
    if (opened && !stick && !keepFromEnd && messages.length > before) newCount += messages.length - before;
    if (stick) newCount = 0;
    setSlot(root, 'lp-head', html`<a class="lp-back" href="#life/phone">‹ ALL CHATS</a>
      <span class="lp-thead">${thread.name || castId}${thread.departed ? html` <span class="chip">LEFT</span>` : ''}</span>
      <a class="mono lp-card" href="${castHref(castId)}">CARD ›</a>`);
    setSlot(root, 'lp-send', sendBar(thread, ro, newCount));
    setSlot(root, 'lp-msgs', messagesView(messages, { sel, editing, ro, more }));
    if (fromEnd !== null && el) el.scrollTop = el.scrollHeight - fromEnd;
    else if (stick) toEnd();
    keepFromEnd = null;
    opened = true;
  }

  function compose() {
    if (!thread || thread.departed || readOnly()) return;
    let leaving = false;
    const sheet = openSheet({
      label: `Text ${thread.name || castId}`,
      content: sendForm(thread, false),
      onClose: () => { if (!leaving) draft = readDraft(form); },
    });
    const form = sheet.body.querySelector('form');
    fillDraft(form, draft);
    ctx.onDispose(sheet.close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = sendAction(castId, new FormData(form));
      if (!action) { flash('SAY WHAT THE TEXT IS ABOUT, OR ITS EXACT WORDS', 'bad'); return; }
      draft = readDraft(form);
      leaving = true;
      sheet.close({ now: true }); // the preview modal can't sit above a sheet in the top layer
      const res = await openPreview(ctx, action, {
        title: `TEXT ${String(thread.name || '').toUpperCase()}`,
        onApplied: () => { reload(); },
      });
      if (res?.applied) draft = null;
    });
  }

  async function loadThread({ before = null } = {}) {
    if (!castId) return;
    let r;
    try {
      r = await api(`/api/arcs/phone/${encodeURIComponent(castId)}?limit=${PAGE}${before ? `&before=${before}` : ''}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err?.status === 404 || err?.status === 400) { thread = null; paintThread(); return; }
      throw err;
    }
    if (!ctx.alive() || !r?.thread) return;
    const page = Array.isArray(r.thread.messages) ? r.thread.messages : [];
    const first = thread === null;
    thread = r.thread;
    messages = merge(messages, page);
    // LOAD OLDER shows while the last page that reached back in time came full.
    if (before || first) more = page.length >= PAGE;
    paintThread();
  }

  async function load() {
    const st = await arcsStatus(ctx);
    if (!ctx.alive()) return;
    setSlot(root, 'lp-off', arcsOffNote(st));
    let r;
    try {
      r = await api('/api/arcs/phone', { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err?.status === 409) {
        setSlot(root, 'lp-threads', html`<div class="empty">HIS PHONE ISN'T AVAILABLE YET</div>`);
        return;
      }
      throw err;
    }
    if (!ctx.alive()) return;
    threads = Array.isArray(r?.threads) ? r.threads : [];
    setSlots(root, { 'lp-count': String(threads.length) });
    setSlot(root, 'lp-threads', r?.enabled ? threadList(threads, castId) : html`<div class="empty">ARCS IS OFF</div>`);
    if (r?.enabled && castId && editing === null) await loadThread();
  }

  const reload = () => { load().catch((err) => { if (!isAbort(err)) console.warn('life phone', err); }); };

  ctx.listen(root, 'click', async (e) => {
    const act = e.target.closest?.('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'to-end') { newCount = 0; painted = ''; toEnd(); paintThread(); return; }
      if (a === 'compose') { compose(); return; }
      if (a === 'older') {
        const oldest = messages[0]?.at;
        keepFromEnd = true;
        if (Number.isSafeInteger(oldest)) loadThread({ before: oldest }).catch((err) => { if (!isAbort(err)) flash(err.message, 'bad'); });
        return;
      }
      if (a === 'cancel') { editing = null; paintThread(); return; }
      if (act.disabled || readOnly()) return;
      if (a === 'edit') { editing = Number(act.dataset.id); paintThread(); $(root, '.lp-edit textarea')?.focus?.(); return; }
      if (a === 'regen') {
        const id = Number(act.dataset.id);
        const { ok } = await askSheet({ label: 'Rewrite this message', text: 'The model writes a new version; the old one is replaced.', action: 'REWRITE' });
        if (!ok || !ctx.alive()) return;
        act.disabled = true;
        try {
          await api(`/api/arcs/phone/messages/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: {} });
          flash('REWRITTEN');
        } catch (err) {
          if (isAbort(err)) return;
          flash(err.message, 'bad');
        }
        sel = null;
        if (ctx.alive()) reload();
        return;
      }
      if (a === 'revert') {
        const ev = Number(act.dataset.ev);
        if (!Number.isSafeInteger(ev) || ev < 1) return;
        const { ok, reason } = await askSheet({ label: 'Revert this message', text: 'It leaves his world, with anything it caused.', action: 'REVERT', danger: true, reasonLabel: 'Reason (optional)', reasonMax: REASON_MAX });
        if (!ok || !ctx.alive()) return;
        act.disabled = true;
        try {
          const res = await api(`/api/life/events/${encodeURIComponent(ev)}/revert`, { method: 'POST', body: { reason } });
          flash(res?.already ? 'WAS ALREADY REVERTED' : 'REVERTED');
        } catch (err) {
          if (isAbort(err)) return;
          flash(err.message, 'bad');
        }
        sel = null;
        if (ctx.alive()) reload();
      }
      return;
    }
    const msg = e.target.closest?.('[data-msg]');
    if (msg && editing === null) {
      const id = Number(msg.dataset.msg);
      sel = sel === id ? null : id;
      paintThread();
    }
  });
  ctx.listen(root, 'keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-msg]')) { e.preventDefault(); e.target.click(); }
  });
  ctx.listen(root, 'submit', async (e) => {
    const edit = e.target.closest?.('[data-edit]');
    if (!edit) return;
    e.preventDefault();
    if (readOnly()) return;
    {
      const id = Number(edit.dataset.edit);
      const text = String(new FormData(edit).get('text') || '').trim();
      if (!text) { flash('A MESSAGE CAN\'T BE EMPTY', 'bad'); return; }
      if (text.length > TEXT_MAX) { flash(`AT MOST ${TEXT_MAX} CHARACTERS`, 'bad'); return; }
      try {
        await api(`/api/arcs/phone/messages/${encodeURIComponent(id)}/text`, { method: 'PUT', body: { text } });
        flash('SAVED');
        editing = null;
        sel = null;
      } catch (err) {
        if (isAbort(err)) return;
        flash(err.message, 'bad');
        return;
      }
      if (ctx.alive()) reload();
    }
  });
  // Back at the newest message: nothing is new any more.
  const atEnd = () => { if (newCount && nearEnd(scroller())) { newCount = 0; paintThread(); } };
  ctx.listen(window, 'scroll', atEnd, { passive: true });
  ctx.listen($(root, '.lp-msgs'), 'scroll', atEnd, { passive: true });

  try {
    await load();
  } catch (err) {
    if (isAbort(err) || !ctx.alive()) return;
    showError(root, err);
    return;
  }
  ctx.setInterval(() => { if (editing === null) reload(); }, POLL_MS);
}
