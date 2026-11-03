// 03.B PERSON DETAIL — dossier, owner-facet edit, cloned voice, calls, and the
// spec 006 views: profile facets per origin (owner first, with its visibility),
// identities, nicknames with where they were learned, memories/relationships with
// origin + audience, the identity merge queue, and purge.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtDay, fmtHm, fmtRelative, fmtTime, maskPhone } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { initFolds } from '../components/views.js';
import { flash } from '../components/flash.js';
import { askSheet } from '../components/sheet.js';
import { mountCalls } from '../components/calls.js';
import { getStatus } from '../components/topbar.js';
import { originCell, VISIBILITY_LABELS } from '../components/provenance.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · CONTACT</div>
    <h1><span data-slot="pd-name">—</span></h1>
  </div>
  <div class="meta">
    <span><a href="#people" class="mute">← ALL CONTACTS</a></span>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>PROFILE<button type="button" class="guide-q" data-guide="dossier" aria-label="Guide: profile">?</button></span><span class="mono mute" data-slot="pd-jid">—</span></div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:64px;height:64px;background:var(--bg-3);border:1px solid var(--line-3);position:relative" class="crosshair">
          <div style="position:absolute;inset:8px;background:var(--bg-2);font-family:var(--font-mono);font-weight:700;font-size: var(--t-h2);color:var(--ink-1);display:grid;place-items:center" data-slot="pd-initials">??</div>
        </div>
        <div>
          <div style="font-size: var(--t-h3);font-weight:600" data-slot="pd-display-name">—</div>
          <div class="mono mute" style="font-size: var(--t-meta)" data-slot="pd-handle">—</div>
          <div class="mono mute" style="font-size: var(--t-meta)" data-slot="pd-seen">—</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size: var(--t-meta)" data-slot="pd-meta"></div>

      <details class="subfold" data-fold="person.edit" data-wide-open><summary class="cap mute">EDIT<span class="fold-mark" aria-hidden="true"></span></summary>
      <form id="pdEditForm" style="display:grid;grid-template-columns:minmax(0,1fr);gap:6px;margin-top:8px">
        <input type="text" name="real_name" placeholder="real_name" aria-label="Real name" />
        <input type="text" name="summary" placeholder="summary" aria-label="Owner summary" />
        <input type="text" name="traits" placeholder="traits (comma separated)" aria-label="Owner traits" />
        <input type="text" name="interests" placeholder="interests (comma separated)" aria-label="Owner interests" />
        <label class="mono mute" style="font-size: var(--t-label)">OWNER PROFILE · WHO MAY HEAR IT
          <select name="visibility">
            <option value="subject_dm">their DM only (default)</option>
            <option value="subject_groups">their DM + outsider-free groups they're in</option>
            <option value="everywhere">everywhere</option>
          </select>
        </label>
        <button data-write class="primary" type="submit">SAVE OWNER PROFILE</button>
      </form>
      <div class="mute mono" style="font-size: var(--t-label);margin-top:4px">summary / traits / interests here are the OWNER facet. Learned facets (per chat) are listed under PROFILE BY ORIGIN.</div>
      </details>
      <details class="subfold" data-fold="person.merges" data-wide-open><summary class="cap mute">IDENTITY MERGES<span class="fold-mark" aria-hidden="true"></span></summary>
      <div class="cap mute" style="font-size: var(--t-label);margin-top:8px">PENDING</div>
      <div data-slot="pd-merges" style="display:grid;gap:6px;margin-top:8px;font-size: var(--t-data)"></div>
      <div class="cap mute" style="font-size: var(--t-label);margin-top:10px">REJECTED</div>
      <div data-slot="pd-merges-rejected" style="display:grid;gap:6px;margin-top:8px;font-size: var(--t-data)"></div>
      </details>
      <details class="subfold" data-fold="person.forget" data-wide-open><summary class="cap mute">FORGET<span class="fold-mark" aria-hidden="true"></span></summary>
      <div style="margin-top:8px;font-size: var(--t-data);display:grid;gap:6px">
        <div class="mute">Purge everything remembered about this person (memories, profile facets, nicknames, relationships, identity forms). Messages stay. Audited (count only).</div>
        <div><button data-write type="button" class="danger" id="pdPurge">PURGE PERSON</button></div>
      </div>
      </details>
      <details class="subfold" data-fold="person.call" data-wide-open><summary class="cap mute">PHONE CALL · 1:1 CONTEXT<span class="fold-mark" aria-hidden="true"></span></summary>
      <div data-slot="pd-call" style="margin-top:8px;font-size: var(--t-data)"></div>
      </details>
      <details class="subfold" data-fold="person.voice" data-wide-open><summary class="cap mute">CLONED VOICE · IMITATE-VOICE<span class="fold-mark" aria-hidden="true"></span></summary>
      <div data-slot="pd-voice" style="display:grid;gap:6px;margin-top:8px;font-size: var(--t-data)"></div>
      </details>
      <details class="subfold" data-fold="person.public" data-wide-open><summary class="cap mute">PUBLIC SITE<span class="fold-mark" aria-hidden="true"></span></summary>
      <form id="pdPublicForm" style="display:grid;grid-template-columns:minmax(0,1fr);gap:6px;margin-top:8px;font-size: var(--t-data)">
        <div class="mute">Off: wherever this person is part of his day, the public site says "a friend". On: it shows the display name below (no surname, photo or number). Turning it off removes the name from the site at the next export.</div>
        <label><input type="checkbox" name="optedIn"> SHOW ON PUBLIC SITE</label>
        <label class="mono mute">DISPLAY NAME <input name="displayName" maxlength="40" placeholder="first name"></label>
        <div><button data-write type="submit">SAVE</button> <span class="mono mute" data-slot="pd-public-state"></span></div>
      </form>
      </details>
      </div>
  </div>

  <div class="panel">
    <details class="fold-in" data-fold="person.facets" data-wide-open><summary class="panel-head"><span>PROFILE BY ORIGIN<button type="button" class="guide-q" data-guide="facets" aria-label="Guide: facets">?</button></span><span class="mono mute" data-slot="pd-facet-count">0</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data">
      <thead><tr><th>ORIGIN</th><th>SUMMARY</th><th>TRAITS</th><th>INTERESTS</th></tr></thead>
      <tbody data-slot="pd-facets"></tbody>
    </table>
    </details>
    <details class="fold-in" data-fold="person.memories" data-wide-open><summary class="panel-head"><span>MEMORIES<button type="button" class="guide-q" data-guide="memories" aria-label="Guide: memories">?</button></span><span class="mono mute" data-slot="pd-mem-count">0</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data">
      <thead><tr><th>CAT</th><th>CONTENT</th><th>ORIGIN</th><th>AUDIENCE</th><th>IMP</th></tr></thead>
      <tbody data-slot="pd-memories"></tbody>
    </table>
    </details>
    <details class="fold-in" data-fold="person.rels" data-wide-open><summary class="panel-head"><span>RELATIONSHIPS<button type="button" class="guide-q" data-guide="relationships" aria-label="Guide: relationships">?</button></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="pd-rels"></tbody></table>
    </details>
    <details class="fold-in" data-fold="person.recent" data-wide-open><summary class="panel-head"><span>RECENT MESSAGES<button type="button" class="guide-q" data-guide="recent" aria-label="Guide: recent">?</button></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="pd-recent"></tbody></table>
    </details>
    <details class="fold-in" data-fold="person.calls" data-wide-open><summary class="panel-head"><span>CALL HISTORY<button type="button" class="guide-q" data-guide="calls" aria-label="Guide: calls">?</button></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="pd-calls"></tbody></table>
    </details>
    </div>
</div>
`);

const chipList = (list, empty = html`<span class="mute">—</span>`) => (list || []).length
  ? list.map((t) => html`<span class="chip">${t}</span>`)
  : empty;

function voiceView(v) {
  if (v.active) {
    return html`
      <div><span class="pill ok">🎙️ ENROLLED</span> <span class="mono mute">via ${v.via || '?'} · ${fmtTime(v.enrolledAt)} · expires ${v.expiresAt ? fmtDay(v.expiresAt) : '—'}</span></div>
      <div class="mute">Used only while this person is being imitated in a group with "use their voice" on.</div>
      <div><button data-write type="button" class="danger" id="pdVoiceDelete">DELETE VOICE</button></div>`;
  }
  const statements = v.consentStatements || {};
  // The persona's language picks the starting consent language (from /api/status).
  const defaultLang = getStatus()?.voiceConsentLanguage || Object.keys(statements)[0];
  return html`
    ${v.revokedAt ? html`<div class="mono mute">previous voice revoked ${fmtTime(v.revokedAt)} (${v.revokeReason || ''})</div>` : ''}
    <div class="mute">Not enrolled. The person can DM the bot <b>voice enroll</b>, or upload <b>their own</b> two recordings here (same phone, same room):</div>
    <label class="mono mute">1 · SAMPLE — 10–30 s of them talking naturally <input type="file" id="pdVoiceSample" accept="audio/*" /></label>
    <label class="mono mute">CONSENT LANGUAGE <select id="pdVoiceLang">${Object.keys(statements).map((k) => html`<option value="${k}" ${k === defaultLang ? raw('selected') : ''}>${k}</option>`)}</select></label>
    <div id="pdVoiceStatement" style="padding:6px;border:1px solid var(--line-2)"></div>
    <label class="mono mute">2 · CONSENT — them reading the sentence above exactly <input type="file" id="pdVoiceConsent" accept="audio/*" /></label>
    <label class="mono mute" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pdVoiceConfirm" /> Both recordings are this person, made by them, and they agreed to a cloned voice</label>
    <div><button data-write type="button" class="primary" id="pdVoiceEnroll">ENROLL VOICE</button></div>`;
}

const readB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ data: String(r.result).split(',')[1] || '', mime: file.type || 'application/octet-stream' });
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export async function mount(ctx, jid) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  let p = null;
  let name = jid;
  let callsMounted = false;
  const enc = () => encodeURIComponent(p?.jid || jid);

  async function load() {
    try {
      p = await api(`/api/people/${encodeURIComponent(jid)}`, { signal: ctx.signal });
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) showError(root, err);
      return;
    }
    if (!ctx.alive()) return;
    if (!callsMounted) {
      mountCalls(ctx, { personJid: p.jid, liveSlot: 'pd-call', historySlot: 'pd-calls' });
      callsMounted = true;
    }
    name = p.real_name || p.push_name || p.jid;
    const initials = name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || '?').join('');
    setSlots(root, {
      'pd-name': name,
      'pd-jid': p.jid,
      'pd-display-name': name,
      'pd-handle': `${maskPhone(p.phone)} · ${p.jid}`,
      'pd-seen': `first_seen ${fmtTime(p.first_seen)} · last_seen ${fmtRelative(p.last_seen)} ago`,
      'pd-initials': initials || '??',
      'pd-mem-count': p.memories?.length || 0,
      'pd-facet-count': p.facets?.length || 0,
    });

    const nicks = (p.nicknames || []).length
      ? p.nicknames.map((n) => html`<span class="chip" title="${`learned in ${n.origin_label || n.origin_jid}`}">${n.nickname}${n.use_count > 1 ? ' · ' + n.use_count : ''} <span class="mute">@ ${n.origin_label || n.origin_kind || '?'}</span></span>`)
      : html`<span class="mute">—</span>`;
    const ids = (p.identities || []).length
      ? p.identities.map((i) => html`<span class="chip" title="${`source ${i.source || '?'}`}">${i.kind || '?'} · ${i.jid}</span>`)
      : html`<span class="mute">—</span>`;
    setSlot(root, 'pd-meta', html`
      <span class="mute">REAL NAME</span><b>${p.real_name || '—'}</b>
      <span class="mute">OWNER SUMMARY</span><span>${p.summary || '—'}</span>
      <span class="mute">OWNER TRAITS</span><span>${chipList(p.traits)}</span>
      <span class="mute">OWNER INTERESTS</span><span>${chipList(p.interests)}</span>
      <span class="mute">OWNER VISIBILITY</span><span>${VISIBILITY_LABELS[p.visibility] || p.visibility || '—'}</span>
      <span class="mute">NICKS</span><span>${nicks}</span>
      <span class="mute">IDENTITIES</span><span>${ids}</span>
      <span class="mute">MESSAGES</span><b>${(p.message_count || 0).toLocaleString()}</b>`);

    const form = $(root, '#pdEditForm');
    if (form) {
      form.real_name.value = p.real_name || '';
      form.summary.value = p.summary || '';
      form.traits.value = (p.traits || []).join(', ');
      form.interests.value = (p.interests || []).join(', ');
      form.visibility.value = p.visibility || 'subject_dm';
    }

    setSlot(root, 'pd-voice', voiceView(p.voice || {}));
    loadPublic().catch(() => {});
    showStatement();

    setSlot(root, 'pd-facets', (p.facets || []).length
      ? p.facets.map((f) => html`<tr>
          <td>${originCell(f)}${f.origin_kind === 'owner' ? html` <span class="mono mute" style="font-size: var(--t-label)">· ${VISIBILITY_LABELS[f.visibility] || f.visibility || ''}</span>` : ''}</td>
          <td>${f.summary || '—'}</td><td>${chipList(f.traits)}</td><td>${chipList(f.interests)}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">NO PROFILE YET</td></tr>`);

    setSlot(root, 'pd-memories', (p.memories || []).length
      ? p.memories.map((m) => html`<tr><td class="mono mute"><span class="${m.category === 'temporary' ? 'chip warn' : 'chip'}">${m.category}</span></td><td>${m.content}</td><td>${originCell(m)}</td><td class="mute" style="font-size: var(--t-label)">${m.audience_summary || ''}</td><td class="num">${(m.importance ?? 0).toFixed(2)}</td></tr>`)
      : html`<tr><td colspan="5" class="empty">NO MEMORIES</td></tr>`);

    setSlot(root, 'pd-rels', (p.relationships || []).length
      ? p.relationships.map((r) => {
        const other = r.person_a_jid === p.jid ? (r.person_b_name || r.person_b_jid) : (r.person_a_name || r.person_a_jid);
        return html`<tr><td><b>${other}</b></td><td>${r.relationship || '—'}${r.dynamic ? html` <span class="mute">· ${r.dynamic}</span>` : ''}</td><td>${originCell(r)}</td><td class="num">${(r.strength ?? 0).toFixed(2)}</td></tr>`;
      })
      : html`<tr><td colspan="4" class="empty">NO RELATIONSHIPS</td></tr>`);

    setSlot(root, 'pd-merges', (p.mergeQueue || []).length
      ? p.mergeQueue.map((m) => html`
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="mono">#${m.id}</span>
          <span>keep <b>${m.keep_name || m.keep_jid}</b> · merge in <b>${m.drop_name || m.drop_jid}</b></span>
          <span class="mono mute" style="font-size: var(--t-label)">${m.reason || ''} · ${fmtRelative(m.created_at)} ago</span>
          <button data-write type="button" class="primary" data-merge="${m.id}" data-decision="approve">APPROVE</button>
          <button data-write type="button" data-merge="${m.id}" data-decision="reject">REJECT</button>
        </div>`)
      : html`<span class="mute mono">—</span>`);
    setSlot(root, 'pd-merges-rejected', (p.rejectedMerges || []).length
      ? p.rejectedMerges.map((m) => html`
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="mono">#${m.id}</span>
          <span><b>${m.keep_name || m.keep_jid}</b> · <b>${m.drop_name || m.drop_jid}</b></span>
          <span class="mono mute" style="font-size: var(--t-label)">${m.reason || ''} · rejected ${fmtRelative(m.decided_at)} ago</span>
        </div>`)
      : html`<span class="mute mono">—</span>`);

    const recent = (p.recentMessages || []).slice(0, 15);
    setSlot(root, 'pd-recent', recent.length
      ? recent.map((m) => html`<tr><td class="id mono">${m.timestamp ? fmtHm(m.timestamp) : '—'}</td><td>${m.content || `[${m.message_type || 'media'}]`}</td></tr>`)
      : html`<tr><td colspan="2" class="empty">NO MESSAGES</td></tr>`);
  }

  function showStatement() {
    const sel = $(root, '#pdVoiceLang');
    const box = $(root, '#pdVoiceStatement');
    if (sel && box) box.textContent = `"${(p?.voice?.consentStatements || {})[sel.value] || ''}"`;
  }

  ctx.listen(root, 'change', (e) => { if (e.target?.id === 'pdVoiceLang') showStatement(); });

  // 013: the public-site opt-in (off by default; the owner picks the display name).
  async function loadPublic() {
    const r = await api(`/api/public/people/${enc()}`, { signal: ctx.signal });
    if (!ctx.alive()) return;
    const f = $(root, '#pdPublicForm');
    if (!f) return;
    const st = r?.setting;
    f.optedIn.checked = st?.optedIn === true;
    f.displayName.value = st?.displayName || (p?.real_name || p?.push_name || '').split(/\s+/)[0] || '';
    setSlot(root, 'pd-public-state', st ? (st.optedIn ? `ON · shown as "${st.displayName}"` : 'OFF · shown as "a friend"') : 'OFF · shown as "a friend"');
  }

  ctx.listen(root, 'submit', async (e) => {
    if (e.target?.id === 'pdPublicForm' && p) {
      e.preventDefault();
      const f = e.target;
      const on = f.optedIn.checked;
      if (on) {
        const { ok } = await askSheet({ label: 'Show on the public site', text: `Show this person on the public site as "${f.displayName.value || '?'}"? Only that name appears, next to the plans and outings they share with him.`, action: 'SHOW THEM', danger: true });
        if (!ok || !ctx.alive()) return;
      }
      try {
        await api(`/api/public/people/${enc()}`, { method: 'PUT', body: { optedIn: on, displayName: f.displayName.value } });
        flash(on ? 'PUBLIC · ON' : 'PUBLIC · OFF');
        loadPublic().catch(() => {});
      } catch (err) { flash(err.message, 'bad'); }
      return;
    }
    if (e.target?.id !== 'pdEditForm' || !p) return;
    e.preventDefault();
    const form = e.target;
    const body = {};
    if (form.real_name.value !== (p.real_name || '')) body.real_name = form.real_name.value;
    if (form.summary.value !== (p.summary || '')) body.summary = form.summary.value;
    const traits = form.traits.value.split(',').map((s) => s.trim()).filter(Boolean);
    const interests = form.interests.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (JSON.stringify(traits) !== JSON.stringify(p.traits || [])) body.traits = traits;
    if (JSON.stringify(interests) !== JSON.stringify(p.interests || [])) body.interests = interests;
    if (form.visibility.value !== (p.visibility || 'subject_dm')) {
      if (form.visibility.value !== 'subject_dm') {
        const { ok } = await askSheet({ label: 'Who may hear it', text: `Widen who may hear the owner profile to "${VISIBILITY_LABELS[form.visibility.value]}"?`, action: 'WIDEN', danger: true });
        if (!ok || !ctx.alive()) return;
      }
      body.visibility = form.visibility.value;
    }
    if (!Object.keys(body).length) { flash('NO CHANGES', 'warn'); return; }
    try { await api(`/api/people/${enc()}`, { method: 'PATCH', body }); flash('SAVED'); load(); } catch (err) { flash(err.message, 'bad'); }
  });

  ctx.listen(root, 'click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || !p) return;
    if (btn.dataset.merge) {
      const approve = btn.dataset.decision === 'approve';
      if (approve) {
        const { ok } = await askSheet({ label: 'Merge two people', text: 'Their DM histories and memories become one person. This cannot be undone.', action: 'MERGE', danger: true });
        if (!ok || !ctx.alive()) return;
      }
      try {
        await api(`/api/people/merge-queue/${encodeURIComponent(btn.dataset.merge)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: {} });
        flash(approve ? 'MERGED' : 'MERGE REJECTED'); load();
      } catch (err) { flash(err.message, 'bad'); }
      return;
    }
    switch (btn.id) {
      case 'pdPurge':
        if (!(await askSheet({ label: 'Purge this person', text: `Purge EVERYTHING remembered about ${name}? Memories, profile facets, nicknames, relationships and any cloned voice are deleted. This cannot be undone.`, action: 'PURGE', danger: true })).ok || !ctx.alive()) return;
        try { const res = await api(`/api/people/${enc()}/purge`, { method: 'POST', body: { confirm: true } }); flash(`PURGED · ${res.deleted} items${res.voice === 'deleted' ? ' · VOICE DELETED' : res.voice === 'delete_pending' ? ' · VOICE REVOKED, DELETE PENDING' : ''}`); load(); } catch (err) { flash(err.message, 'bad'); }
        return;
      case 'pdVoiceDelete':
        if (!(await askSheet({ label: 'Delete this voice', text: 'Delete this cloned voice? This also deletes it at Google.', action: 'DELETE VOICE', danger: true })).ok || !ctx.alive()) return;
        try { await api(`/api/people/${enc()}/voice`, { method: 'DELETE' }); flash('VOICE DELETED'); load(); } catch (err) { flash(err.message, 'bad'); }
        return;
      case 'pdVoiceEnroll': {
        const sample = $(root, '#pdVoiceSample')?.files?.[0];
        const consent = $(root, '#pdVoiceConsent')?.files?.[0];
        if (!sample || !consent) { flash('Pick both recordings', 'bad'); return; }
        if (!$(root, '#pdVoiceConfirm')?.checked) { flash('Confirm the consent checkbox', 'bad'); return; }
        btn.disabled = true; btn.textContent = 'ENROLLING…';
        try {
          const body = {
            sample: await readB64(sample),
            consent: await readB64(consent),
            languageCode: $(root, '#pdVoiceLang')?.value,
            confirmOwnerConsent: true,
          };
          await api(`/api/people/${enc()}/voice`, { method: 'POST', body });
          flash('VOICE ENROLLED'); load();
        } catch (err) {
          flash(err.message, 'bad');
          if (ctx.alive()) { btn.disabled = false; btn.textContent = 'ENROLL VOICE'; }
        }
        return;
      }
      default:
    }
  });

  await load();
}
