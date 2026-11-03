// 02.B GROUP DETAIL — dossier, controls (vibe, language, mute, imitate, force sends), members,
// recent messages, memories learned here, phone calls with the group's context.
//
// Spec 006: membership sync time + freshness (stale → group items stay in this
// chat), slang with where it was heard (★ = elsewhere, global meaning), nicknames
// learned here, memories with their audience summary.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtHm, fmtRelative, fmtTime } from '../core/fmt.js';
import { showError } from '../components/ui.js';
import { initFolds } from '../components/views.js';
import { flash } from '../components/flash.js';
import { mountCalls, botName } from '../components/calls.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CHATS · GROUP</div>
    <h1><span data-slot="gd-name">—</span></h1>
  </div>
  <div class="meta">
    <span><a href="#groups" class="mute">← ALL GROUPS</a></span>
    <span data-slot="gd-state">—</span>
  </div>
</div>

<div class="panel gd-controls">
  <div class="panel-head"><span>CONTROLS<button type="button" class="guide-q" data-guide="vibe" aria-label="Guide: controls">?</button></span></div>
  <div class="panel-body" style="display:grid;gap:8px" data-slot="gd-controls"></div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>ABOUT THIS GROUP<button type="button" class="guide-q" data-guide="focus" aria-label="Guide: about this group">?</button></span><span class="mono mute" data-slot="gd-jid">—</span></div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size: var(--t-meta)" data-slot="gd-meta"></div>

      <details class="subfold" data-fold="group.words" data-wide-open><summary class="cap mute">SLANG + NICKNAMES<span class="fold-mark" aria-hidden="true"></span></summary>
      <div><b class="cap mute">SLANG</b> <span class="mono mute" style="font-size: var(--t-label)">· ★ = heard elsewhere, global meaning</span></div>
      <div style="margin-top:6px" data-slot="gd-slang"><span class="mute mono">—</span></div>

      <div style="margin-top:14px"><b class="cap mute">NICKNAMES · LEARNED HERE</b></div>
      <div style="margin-top:6px" data-slot="gd-nicks"><span class="mute mono">—</span></div>
      </details>

      <details class="subfold" data-fold="group.call" data-wide-open><summary class="cap mute">PHONE CALL · GROUP CONTEXT<span class="fold-mark" aria-hidden="true"></span></summary>
      <div data-slot="gd-call" style="margin-top:8px;font-size: var(--t-data)"></div>
      </details>
      </div>
  </div>

  <div class="panel">
    <details class="fold-in" data-fold="group.messages" data-wide-open><summary class="panel-head"><span>LAST MESSAGES<button type="button" class="guide-q" data-guide="messages" aria-label="Guide: messages">?</button></span><span class="dot-live"></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="gd-messages"></tbody></table>
    </details>
    <details class="fold-in" data-fold="group.members" data-wide-open><summary class="panel-head"><span>MEMBERS<button type="button" class="guide-q" data-guide="members" aria-label="Guide: members">?</button></span><span class="mono mute" data-slot="gd-member-count">0</span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="gd-members"></tbody></table>
    </details>
    <details class="fold-in" data-fold="group.memories" data-wide-open><summary class="panel-head"><span>GROUP MEMORIES · LEARNED HERE<button type="button" class="guide-q" data-guide="memories" aria-label="Guide: memories">?</button></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <div class="panel-body" data-slot="gd-memories"><span class="mute mono">—</span></div>
    </details>
    <details class="fold-in" data-fold="group.calls" data-wide-open><summary class="panel-head"><span>CALL HISTORY<button type="button" class="guide-q" data-guide="calls" aria-label="Guide: calls">?</button></span><span class="fold-mark" aria-hidden="true"></span></summary>
    <table class="data"><tbody data-slot="gd-calls"></tbody></table>
    </details>
    </div>
</div>
`);

const none = () => html`<span class="mute mono">—</span>`;

const SOURCE_LABEL = { owner: 'SET BY OWNER', learned: 'LEARNED', default: 'DEFAULT' };
const sourceChip = (source) => html`<span class="pill ${source === 'owner' ? 'ok' : ''}">${SOURCE_LABEL[source] || 'LEARNED'}</span>`;

function controlsView(g) {
  const im = g.imitation;
  const src = g.field_sources || {};
  const memberName = (m) => m.push_name || m.real_name || m.person_jid;
  return html`
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input type="text" id="gdVibe" placeholder="vibe" aria-label="Vibe" value="${g.vibe || ''}" style="flex:1;min-width:200px" />
      <button data-write type="button" id="gdSaveVibe">SAVE VIBE</button>
      ${sourceChip(src.vibe)}
      ${src.vibe === 'owner' ? html`<button data-write type="button" id="gdReleaseVibe" title="Let batch learning write the vibe again">HAND BACK TO LEARNING</button>` : ''}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input type="text" id="gdLang" placeholder="language · e.g. English" aria-label="Language" maxlength="40" value="${g.language || ''}" style="flex:1;min-width:200px" />
      <button data-write type="button" id="gdSaveLang">SAVE LANGUAGE</button>
      ${sourceChip(src.language)}
      ${src.language === 'owner' ? html`<button data-write type="button" id="gdReleaseLang" title="Back to the default (en)">RESET TO DEFAULT</button>` : ''}
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${g.muted
        ? html`<button data-write type="button" class="danger" id="gdUnmute">UNMUTE</button>`
        : html`<input type="number" id="gdMuteMin" placeholder="min · blank=∞" aria-label="Mute minutes" style="width:14ch" /><button data-write type="button" class="danger" id="gdMute">MUTE</button>`}
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${im
        ? html`<span class="pill bad">🎭 IMITATING ${im.label || im.targetJid} · until ${fmtHm(im.activeUntil || 0)}</span><button data-write type="button" class="danger" id="gdImitateOff">STOP IMITATING</button>`
        : html`<select id="gdImitateTarget" aria-label="Member to imitate" style="flex:1;min-width:160px"><option value="">🎭 imitate member…</option>${(g.members || []).map((m) => html`<option value="${m.person_jid}">${memberName(m)}</option>`)}</select><input type="number" id="gdImitateMin" placeholder="min · blank=max" aria-label="Imitation minutes" style="width:14ch" /><label class="mono mute" style="display:flex;align-items:center;gap:4px" title="Only if the member enrolled a voice"><input type="checkbox" id="gdImitateVoice" /> 🎙️ THEIR VOICE</label><button data-write type="button" id="gdImitateOn">IMITATE</button>`}
    </div>
    ${im ? html`<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${im.voiceEnrolled
      ? html`<span class="pill ${im.useVoice ? 'bad' : ''}">🎙️ CLONED VOICE ${im.useVoice ? 'ON' : 'OFF'} · ${im.voiceNotesSent || 0}/${im.voiceMaxPerSession > 0 ? im.voiceMaxPerSession : '∞'} notes</span><button data-write type="button" id="gdImitateVoiceToggle">${im.useVoice ? 'VOICE OFF' : 'USE THEIR VOICE'}</button>${im.voiceSkillEnabled ? '' : html`<span class="mono mute" style="font-size: var(--t-label)">imitate-voice skill is OFF (Skills tab)</span>`}`
      : html`<span class="mono mute" style="font-size: var(--t-label)">🎙️ no enrolled voice — they can DM the bot "voice enroll" or you can upload on their person page</span>`}</div>` : ''}
    ${g.warmupBlocksText ? html`<div class="mute mono" style="font-size: var(--t-label)">warmup active — imitation (like all text replies) is inert until warmup allows text</div>` : ''}
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="text" id="gdForceText" placeholder="optional · exact text" aria-label="Exact text" style="flex:1;min-width:200px" />
      <button data-write type="button" class="primary" id="gdForce">FORCE REPLY</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button data-write type="button" id="gdSendSticker" data-media="sticker">▸ SEND STICKER</button>
      <button data-write type="button" id="gdSendGif" data-media="gif">▸ SEND GIF</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="text" id="gdForceVoiceText" placeholder="optional · text to speak (blank = LLM reply)" aria-label="Text to speak" style="flex:1;min-width:200px" />
      <label class="mono mute" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="gdVoiceSing" /> SING</label>
      <button data-write type="button" id="gdSendVoice">▸ SEND VOICE</button>
    </div>`;
}

export async function mount(ctx, jid) {
  const root = ctx.root;
  render(root, SHELL);
  initFolds(root);
  let g = null;
  let callsMounted = false;
  const enc = () => encodeURIComponent(g?.jid || jid);

  async function load() {
    try {
      g = await api(`/api/groups/${encodeURIComponent(jid)}`, { signal: ctx.signal });
    } catch (err) {
      if (!isAbort(err) && ctx.alive()) showError(root, err);
      return;
    }
    if (!ctx.alive()) return;
    if (!callsMounted) {
      mountCalls(ctx, { groupJid: g.jid, liveSlot: 'gd-call', historySlot: 'gd-calls' });
      callsMounted = true;
    }
    setSlots(root, { 'gd-name': g.name || g.jid, 'gd-jid': g.jid, 'gd-member-count': g.members?.length || 0 });
    setSlot(root, 'gd-state', html`${g.muted ? html`<span class="pill bad">MUTED</span>` : html`<span class="pill ok">ACTIVE</span>`}${g.imitation ? html` <span class="pill bad">IMITATING · ${g.imitation.label || g.imitation.targetJid}</span>` : ''}`);

    const meta = [
      ['JID', g.jid],
      ['NAME', g.name || '—'],
      ['VIBE', html`${g.vibe || '—'} <span class="mute">· ${(SOURCE_LABEL[g.field_sources?.vibe] || 'LEARNED').toLowerCase()}</span>`],
      ['LANG', html`${g.language || '—'} <span class="mute">· ${(SOURCE_LABEL[g.field_sources?.language] || 'DEFAULT').toLowerCase()}</span>`],
      ['MEMBERS', `${g.member_count_synced ?? g.members?.length ?? 0} synced`],
      ['SYNCED_AT', g.members_synced_at
        ? `${fmtRelative(g.members_synced_at)} ago · ${g.membership_fresh ? 'fresh' : 'stale — group items stay in this chat'}`
        : 'never — group items stay in this chat'],
      ['AVG_MSG_HR', g.avg_messages_hr ?? g.avgMessagesHr ?? '—'],
      ['LAST ACTIVE', fmtRelative(g.last_active || g.lastActive)],
      ['JOINED', fmtTime(g.joined_at || g.joinedAt)],
    ];
    setSlot(root, 'gd-meta', meta.map(([k, v]) => html`<span class="mute">${k}</span><b>${v}</b>`));

    setSlot(root, 'gd-slang', (g.slang || []).length
      ? g.slang.map((s) => {
        const elsewhere = s.origin_jid !== g.jid;
        return html`<span class="chip" title="${`heard in ${s.origin_label || s.origin_jid}${s.meaning ? ' · ' + s.meaning : ''}`}">${elsewhere ? '★ ' : ''}${s.term}${s.use_count > 1 ? ' · ' + s.use_count : ''}</span>`;
      })
      : none());
    setSlot(root, 'gd-nicks', (g.nicknames || []).length
      ? g.nicknames.map((n) => html`<span class="chip" title="${`${n.push_name || n.real_name || n.person_jid} · ${n.source || ''}`}">${n.nickname} → ${n.real_name || n.push_name || '?'}</span>`)
      : none());

    setSlot(root, 'gd-controls', controlsView(g));

    setSlot(root, 'gd-members', (g.members || []).length
      ? g.members.map((m) => html`<tr><td><a href="#person/${encodeURIComponent(m.person_jid)}"><b>${m.real_name || m.push_name || m.person_jid}</b></a></td><td class="mono mute">${m.role || '—'}</td><td class="mute">${(m.summary || '').slice(0, 60)}</td><td><button data-write type="button" data-call-member="${m.person_jid}" title="Call with this group's context">CALL</button></td></tr>`)
      : html`<tr><td colspan="4" class="empty">NO MEMBERS</td></tr>`);

    const msgs = (g.recentMessages || []).slice(0, 12);
    const me = botName();
    setSlot(root, 'gd-messages', msgs.length
      ? msgs.map((m) => html`<tr class="${m.is_from_self ? 'self' : ''}"><td class="id mono">${m.timestamp ? fmtHm(m.timestamp) : '—'}</td><td>${m.is_from_self ? html`<b class="red-bright">${me}:</b>` : html`<b>${m.sender_name || '—'}:</b>`} ${m.content || `[${m.message_type || 'media'}]`}</td></tr>`)
      : html`<tr><td colspan="2" class="empty">NO MESSAGES YET</td></tr>`);

    setSlot(root, 'gd-memories', (g.memories || []).length
      ? html`<table class="data"><tbody>${g.memories.map((m) => html`<tr><td class="mono mute">${m.category}</td><td>${m.content}</td><td class="mute" style="font-size: var(--t-label)">${m.audience_summary || ''}</td><td class="num">${(m.importance ?? 0).toFixed(2)}</td></tr>`)}</tbody></table>`
      : none());
  }

  const post = (path, body = {}, extra = {}) => api(`/api/groups/${enc()}${path}`, { method: 'POST', body, ...extra });
  const val = (sel) => $(root, sel)?.value ?? '';

  ctx.listen(root, 'click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || !g) return;
    switch (btn.id) {
      case 'gdSaveVibe':
      case 'gdSaveLang':
      case 'gdReleaseVibe':
      case 'gdReleaseLang': {
        const body = {
          gdSaveVibe: { vibe: val('#gdVibe') },
          gdSaveLang: { language: val('#gdLang') },
          gdReleaseVibe: { release: ['vibe'] },
          gdReleaseLang: { release: ['language'] },
        }[btn.id];
        try {
          const res = await api(`/api/groups/${enc()}`, { method: 'PATCH', body });
          flash(res.changes?.released?.length ? `HANDED BACK · ${res.changes.released.join(', ').toUpperCase()}` : btn.id === 'gdSaveLang' ? 'LANGUAGE UPDATED' : 'VIBE UPDATED');
          load();
        } catch (err) { flash(err.message, 'bad'); }
        return;
      }
      case 'gdUnmute':
        try { await post('/unmute'); flash('UNMUTED'); load(); } catch (err) { flash(err.message, 'bad'); }
        return;
      case 'gdMute': {
        const min = val('#gdMuteMin');
        try { await post('/mute', min ? { durationMinutes: Number(min) } : {}); flash('MUTED'); load(); } catch (err) { flash(err.message, 'bad'); }
        return;
      }
      case 'gdImitateOn': {
        const targetJid = val('#gdImitateTarget');
        if (!targetJid) { flash('Pick a member to imitate', 'bad'); return; }
        const min = val('#gdImitateMin');
        const body = { targetJid };
        if (min) body.durationMinutes = Number(min);
        if ($(root, '#gdImitateVoice')?.checked) body.useVoice = true;
        btn.disabled = true;
        try {
          const res = await post('/imitate', body);
          flash(`IMITATING ${res.label} · ${res.corpus} msgs in corpus`); load();
        } catch (err) { flash(err.message, 'bad'); btn.disabled = false; }
        return;
      }
      case 'gdImitateVoiceToggle':
        try {
          const res = await post('/imitate/voice', { useVoice: !g.imitation?.useVoice });
          flash(res.useVoice ? 'CLONED VOICE ON' : 'CLONED VOICE OFF'); load();
        } catch (err) { flash(err.message, 'bad'); }
        return;
      case 'gdImitateOff':
        try { await post('/imitate/off'); flash('IMITATION STOPPED'); load(); } catch (err) { flash(err.message, 'bad'); }
        return;
      case 'gdForce': {
        btn.disabled = true;
        const text = val('#gdForceText').trim();
        try { const res = await post('/respond', text ? { text } : {}); flash(`SENT · ${(res.text || '').slice(0, 80)}`); load(); } catch (err) { flash(err.message, 'bad'); btn.disabled = false; }
        return;
      }
      case 'gdSendSticker':
      case 'gdSendGif': {
        const kind = btn.dataset.media;
        btn.disabled = true;
        try { const res = await post(`/send-${kind}`); flash(`${kind.toUpperCase()} SENT · query=${res.query || '?'}`); } catch (err) { flash(err.message, 'bad'); }
        btn.disabled = false;
        return;
      }
      case 'gdSendVoice': {
        const label = btn.textContent;
        const text = val('#gdForceVoiceText').trim();
        const sing = !!$(root, '#gdVoiceSing')?.checked;
        const body = {}; if (text) body.text = text; if (sing) body.sing = true;
        // Blank text => the server runs a full LLM generation + TTS + ffmpeg, which is
        // slow; cap the wait so a stalled LLM can't leave the button stuck disabled.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        ctx.onDispose(() => { clearTimeout(timer); });
        btn.disabled = true; btn.textContent = '▸ SENDING…';
        try {
          const res = await post('/send-voice', body, { signal: ctrl.signal });
          flash(`VOICE SENT${res.clonedVoiceOf ? ` AS ${res.clonedVoiceOf} 🎙️` : ''} · ${res.duration ?? '?'}s · ${(res.text || '').slice(0, 50)}`);
        } catch (err) {
          flash(ctrl.signal.aborted ? 'Voice send timed out — LLM/TTS too slow' : err.message, 'bad');
        } finally {
          clearTimeout(timer);
          if (ctx.alive()) { btn.disabled = false; btn.textContent = label; }
        }
        return;
      }
      default:
    }
  });

  await load();
}
