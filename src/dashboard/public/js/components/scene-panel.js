// HOW IT WENT (spec 016) — one scene of an outing: the narration, what each side
// thought (first meetings), what they talked about, the highlight and the
// awkward moment, the chemistry, how it ended, what it changed in his world, and
// who wrote it. Shared by Life · Day (a social span's panel) and Life · Cast
// member (READ THE SCENE in the scene history).
//
// Owner actions (write mode only): REGENERATE (a new version with an optional
// tone hint and its outcome word — the hint sets the outcome; the old one and its
// effects are reverted — POST /api/arcs/scenes/:id/regenerate; a reverted scene
// whose outing is still in his day can be rewritten too), EDIT TEXT (the narration
// only; effects unchanged — PUT /api/arcs/scenes/:id/text) and REVERT THIS CHANGE
// (the life revert route on the scene's event). A real person's scene is written
// by code from his side and takes none of them but REVERT.
// Reads GET /api/arcs/scenes/:id. Every string reaches the DOM through html``.
import { api, isAbort } from '../core/api.js';
import { html, render, $ } from '../core/dom.js';
import { fmtTime, fmtHm } from '../core/fmt.js';
import { flash } from './flash.js';

export const TONE_MAX = 120;
export const TEXT_MAX = 2400;   // a long outing; the server still refuses a short one over 1200
const REASON_MAX = 200;
// Tone hints to start from (neutral words; the owner can type anything ≤ 120 chars).
export const TONE_CHIPS = Object.freeze(['they hit it off', 'awkward but sweet', 'not interested', 'they swap numbers', 'a quiet, easy evening', 'it falls flat']);
// The outcome word each chip implies (a hint sets the scene's outcome, so the two always agree).
export const TONE_OUTCOME = Object.freeze({
  'they hit it off': 'well', 'awkward but sweet': 'fine', 'not interested': 'flat', 'they swap numbers': 'well',
  'a quiet, easy evening': 'fine', 'it falls flat': 'flat',
});
export const OUTCOME_WORDS = Object.freeze(['well', 'fine', 'flat', 'badly']);
// A refused or failed REGENERATE / EDIT in words (the route answers codes).
const REFUSAL_WORDS = {
  regen_cap: 'DAILY REWRITE LIMIT REACHED', not_live: 'THIS VERSION IS NO LONGER LIVE', busy: 'A REWRITE IS ALREADY RUNNING',
  real_person: 'A REAL PERSON\'S SCENE IS WRITTEN BY CODE · IT CAN ONLY BE REVERTED', outcome_required: 'PICK HOW IT GOES (THE OUTCOME) FOR THE HINT',
  outcome_conflict: 'THAT OUTCOME DISAGREES WITH THE ONE SET FOR THIS OUTING', paused: 'THE DIRECTOR IS PAUSED',
  heavy: 'NOT DURING A HARD STRETCH', not_available: 'NOT AVAILABLE ON THIS VERSION',
};
const VERSION_WORDS = { skipped: 'failed rewrite', superseded: 'replaced', reverted: 'reverted', fallback: 'one line', done: 'live' };

/** A refusal / failure code → words for the flash. */
export function refusalWords(err) {
  const code = String(err?.body?.error ?? err?.data?.error ?? '').replace(/^invalid:.*$/, 'invalid');
  if (REFUSAL_WORDS[code]) return REFUSAL_WORDS[code];
  const status = err?.body?.status ?? err?.data?.status;
  if (status === 'failed' || code === 'invalid' || /^(invalid|model_)/.test(String(err?.body?.error ?? ''))) return 'THE REWRITE COULD NOT BE WRITTEN · THE OLD VERSION STAYS';
  return null;
}
export const ENDING_WORDS = Object.freeze({
  nothing: 'PARTED AS USUAL', swapped_numbers: 'SWAPPED NUMBERS', plan_to_meet: 'PLAN TO MEET AGAIN',
  stayed_late: 'STAYED LATE', left_early: 'LEFT EARLY', parted_badly: 'PARTED BADLY',
});
const ENDING_TONE = { swapped_numbers: 'ok', plan_to_meet: 'ok', stayed_late: 'ok', left_early: 'warn', parted_badly: 'bad' };
const TIER_WORDS = { mind: 'written by the mind', clerk: 'written by the clerk', code: 'one line from code (no model call)' };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const dis = (on) => (on ? 'disabled' : '');

/** The ending as a chip word ('' for none). */
export function endingWord(e) {
  return ENDING_WORDS[e] ?? (typeof e === 'string' && e ? e.replace(/_/g, ' ').toUpperCase() : '');
}

/** Narration → paragraphs (the owner's edit wins). */
export function paragraphs(s) {
  const t = typeof s?.editedText === 'string' && s.editedText.trim() ? s.editedText : s?.text;
  return typeof t === 'string' ? t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
}

/** "HE THOUGHT" / "<NAME> THOUGHT": his side is "he"; theirs by pronouns, else by name. */
export function thoughtLabel(side, x, many) {
  if (side === 'him') return many && x?.name ? `HE THOUGHT OF ${String(x.name).split(' ')[0].toUpperCase()}` : 'HE THOUGHT';
  const p = String(x?.pronouns || '').toLowerCase();
  if (!many && /^she\b/.test(p)) return 'SHE THOUGHT';
  if (!many && /^he\b/.test(p)) return 'HE THOUGHT (THEM)';
  if (!many && /^they\b/.test(p)) return 'THEY THOUGHT';
  return `${String(x?.name || 'THEY').split(' ')[0].toUpperCase()} THOUGHT`;
}

function chemistryBar(c) {
  if (!finite(c)) return '';
  const p = Math.max(0, Math.min(100, Math.round(c * 100)));
  return html`<div class="factor-bar scene-chem"><span class="label">CHEMISTRY</span><span class="track"><span class="f life-f" style="width:${p}%"></span></span><span class="num">${c.toFixed(2)}</span></div>`;
}

function whoWrote(s) {
  const bits = [TIER_WORDS[s.tier] ?? (s.tier ? `written by ${s.tier}` : null), s.fellBack ? 'the mind fell back' : null, s.model ? s.model : null,
    finite(s.costUsd) ? `$${s.costUsd.toFixed(2)}` : null, s.skipReason ? `(${s.skipReason})` : null].filter(Boolean);
  return bits.join(' · ');
}

/**
 * The panel body for a scene (the route's shape). opts: { ro, editing, regen }
 * ro: write mode off (buttons disabled); editing: show the text editor; regen: show the tone box.
 */
export function sceneView(s, { ro = true, editing = false, regen = false, confirmRevert = false } = {}) {
  if (!s) return html`<div class="empty">NO SCENE</div>`;
  const off = ro || s.excluded || s.live === false;   // only the live version can be edited or reverted
  const real = s.realPerson === true;
  const canRegen = !ro && !real && (s.regenerable === true || (s.regenerable === undefined && !off));
  const paras = paragraphs(s);
  const imp = s.impressions || {};
  const him = Array.isArray(imp.him) ? imp.him : [];
  const them = Array.isArray(imp.them) ? imp.them : [];
  const many = (s.with || []).length > 1;
  const who = (s.with || []).map((w) => `${w.name || '?'}${w.firstMeet ? ' (new)' : ''}`).join(', ');
  return html`<div class="scene-panel ${s.excluded ? 'is-reverted' : ''}" data-scene="${s.id}">
    <div class="scene-head mono">
      <span>${s.at ? `${fmtTime(s.at)}${s.end ? `–${fmtHm(s.end)}` : ''}` : ''}${s.kind ? ` · ${String(s.kind).toUpperCase()}` : ''}${s.place ? ` · ${s.place}` : ''}${who ? ` · with ${who}` : ''}${s.realPerson ? ` · with ${s.friend || 'a friend'}` : ''}</span>
      <span>${s.tone ? html`<span class="chip warn" title="your tone hint">TONE: ${s.tone}</span>` : html`<span class="chip">TONE: LET IT HAPPEN</span>`}
        ${s.version > 1 ? html` <span class="chip">V${s.version}</span>` : ''}${s.excluded ? html` <span class="chip bad">REVERTED</span>` : ''}${s.editedText ? html` <span class="chip">EDITED</span>` : ''}</span>
    </div>
    ${s.realPerson ? html`<div class="mono mute scene-note">A real person was there: written by code from his side only (no model, nothing about them), never published, and it reaches only chats where they are. It can only be reverted.</div>` : ''}
    ${editing
      ? html`<form class="scene-edit" data-scene-form="edit">
          <label class="mono mute" for="sceneText">EDIT THE TEXT (the effects stay as they are)</label>
          <textarea id="sceneText" name="text" rows="8" maxlength="${TEXT_MAX}">${paras.join('\n\n')}</textarea>
          <div><button type="submit" class="primary">SAVE TEXT</button> <button type="button" data-scene-act="cancel">CANCEL</button></div>
        </form>`
      : html`<div class="scene-text">${paras.length ? paras.map((p) => html`<p>${p}</p>`) : html`<p class="mute">No text.</p>`}</div>`}
    ${him.length || them.length ? html`<div class="scene-thoughts">
        ${him.map((x) => html`<div class="scene-box"><div class="scene-k mono">${thoughtLabel('him', x, many)}</div><div>${x.text}</div></div>`)}
        ${them.map((x) => html`<div class="scene-box"><div class="scene-k mono">${thoughtLabel('them', x, many)}</div><div>${x.text}</div></div>`)}
      </div>` : ''}
    ${(s.topics || []).length ? html`<div class="scene-row"><span class="scene-k mono">TALKED ABOUT</span> ${s.topics.map((t) => html`<span class="chip">${t}</span> `)}</div>` : ''}
    ${s.highlight || s.awkward ? html`<div class="scene-thoughts">
        ${s.highlight ? html`<div class="scene-box"><div class="scene-k mono">HIGHLIGHT</div><div>${s.highlight}</div></div>` : ''}
        ${s.awkward ? html`<div class="scene-box"><div class="scene-k mono">AWKWARD</div><div>${s.awkward}</div></div>` : ''}
      </div>` : ''}
    ${chemistryBar(s.chemistry)}
    <div class="scene-row"><span class="scene-k mono">ENDING</span> ${s.ending ? html`<span class="chip ${ENDING_TONE[s.ending] ?? ''}">${endingWord(s.ending)}</span>` : html`<span class="mute">—</span>`}
      ${s.outcome ? html` <span class="mono mute">· outcome ${s.outcome}${s.outcomeBy ? ` (${s.outcomeBy === 'owner' ? 'set by you' : 'rolled by code'})` : ''}</span>` : ''}</div>
    <div class="scene-row"><span class="scene-k mono">WHAT CHANGED</span>
      ${(s.effects || []).length ? html`<ul class="scene-effects mono">${s.effects.map((e) => html`<li>${e}</li>`)}</ul>`
        : html`<span class="mono mute">${s.mode === 'full' ? 'nothing in his world' : 'nothing (a scene from a chat or with a real person changes nothing)'}</span>`}</div>
    <div class="mono mute scene-meta">${whoWrote(s)}${(s.versions || []).length > 1 ? ` · versions: ${s.versions.map((v) => `v${v.version} ${VERSION_WORDS[v.status] || v.status || ''}${v.status === 'skipped' && v.skipReason ? ` (${v.skipReason})` : ''}`.trim()).join(', ')}` : ''}</div>
    ${regen ? html`<form class="scene-regen" data-scene-form="regen">
        <label class="mono mute" for="sceneTone">HOW SHOULD IT GO? (OPTIONAL TONE HINT + ITS OUTCOME · A NEW VERSION${s.excluded ? '' : ', THE OLD ONE AND ITS EFFECTS ARE REVERTED'})</label>
        <input id="sceneTone" name="tone" maxlength="${TONE_MAX}" autocomplete="off" value="${s.tone || ''}">
        <select id="sceneOutcome" name="outcome" aria-label="Outcome of the hint"><option value="">OUTCOME (WITH A HINT)</option>${OUTCOME_WORDS.map((o) => html`<option value="${o}" ${s.toneOutcome === o ? 'selected' : ''}>${o.toUpperCase()}</option>`)}</select>
        <div class="scene-chips">${TONE_CHIPS.map((t) => html`<button type="button" class="chip" data-scene-tone="${t}">${t}</button> `)}</div>
        <div><button type="submit" class="primary">REGENERATE NOW</button> <button type="button" data-scene-act="cancel">CANCEL</button></div>
      </form>` : ''}
    ${confirmRevert ? html`<form class="life-revert" data-scene-form="revert">
        <label class="mono mute" for="sceneReason">REVERT THIS CHANGE — the scene and everything it caused (#${s.eventId}); reason, optional</label>
        <input id="sceneReason" name="reason" maxlength="${REASON_MAX}" autocomplete="off">
        <button type="submit" class="danger">REVERT</button> <button type="button" data-scene-act="cancel">CANCEL</button>
      </form>` : ''}
    <div class="scene-actions">
      <button type="button" data-scene-act="regen" ${dis(!canRegen || editing)}>REGENERATE</button>
      <button type="button" data-scene-act="edit" ${dis(off || real || regen)}>EDIT TEXT</button>
      <button type="button" class="danger" data-scene-act="revert" ${dis(off || !s.eventId || s.revertible === false)} title="${s.revertible === false && s.revertReason ? `not now: ${s.revertReason}` : ''}">REVERT THIS CHANGE</button>
      ${s.eventId ? html`<a class="mono" href="#life/timeline">open on Timeline (#${s.eventId})</a>` : ''}
      ${ro ? html`<span class="mono mute">read-only dashboard</span>` : ''}
    </div>
  </div>`;
}

/**
 * Mount the panel into `slot`. deps: { readOnly() → bool, onChanged?(), onClose?() }
 * → { show(sceneId), clear(), current() }
 */
export function mountScenePanel(ctx, slot, deps = {}) {
  let id = null;
  let scene = null;
  let mode = null;   // null | 'edit' | 'regen' | 'revert'
  const ro = () => (typeof deps.readOnly === 'function' ? deps.readOnly() : true);
  const paint = () => {
    if (!slot || !ctx.alive()) return;
    if (!scene) return;
    render(slot, sceneView(scene, { ro: ro(), editing: mode === 'edit', regen: mode === 'regen', confirmRevert: mode === 'revert' }));
  };
  async function show(sceneId) {
    id = sceneId;
    mode = null;
    if (!slot) return;
    render(slot, html`<div class="loading">LOADING</div>`);
    try {
      const r = await api(`/api/arcs/scenes/${encodeURIComponent(sceneId)}`, { signal: ctx.signal });
      if (!ctx.alive() || id !== sceneId) return;
      if (!r?.enabled) { render(slot, html`<div class="empty">THE STORY IS OFF · SCENES NEED LIFE AND THE ARCS SKILL</div>`); return; }
      if (!r.scene) { render(slot, html`<div class="empty">${r.available === false ? 'SCENES ARE NOT AVAILABLE ON THIS VERSION' : 'NO SCENE'}</div>`); return; }
      scene = r.scene;
      paint();
    } catch (err) {
      if (isAbort(err) || !ctx.alive()) return;
      render(slot, html`<div class="empty">${err.status === 404 ? 'NO SUCH SCENE' : err.message}</div>`);
    }
  }
  const done = async (msg, nextId = id) => {
    flash(msg);
    deps.onChanged?.();
    if (ctx.alive()) await show(nextId);
  };
  const busy = (form, on) => form?.querySelectorAll('button').forEach((b) => { b.disabled = on; });

  ctx.listen(slot, 'click', (e) => {
    const chip = e.target.closest?.('[data-scene-tone]');
    if (chip) {
      const inp = $(slot, '#sceneTone');
      if (inp) inp.value = chip.dataset.sceneTone;
      const sel = $(slot, '#sceneOutcome');
      if (sel && TONE_OUTCOME[chip.dataset.sceneTone]) sel.value = TONE_OUTCOME[chip.dataset.sceneTone];
      return;
    }
    const act = e.target.closest?.('[data-scene-act]')?.dataset.sceneAct;
    if (!act || !scene) return;
    if (act === 'cancel') { mode = null; paint(); return; }
    if (ro()) return;
    if (act === 'regen' ? !(scene.regenerable === true || (scene.regenerable === undefined && !scene.excluded && scene.live !== false)) || scene.realPerson
      : (scene.excluded || scene.live === false || (act === 'edit' && scene.realPerson))) return;
    mode = act === 'edit' ? 'edit' : act === 'regen' ? 'regen' : act === 'revert' ? 'revert' : null;
    paint();
    (mode === 'edit' ? $(slot, '#sceneText') : mode === 'regen' ? $(slot, '#sceneTone') : $(slot, '#sceneReason'))?.focus?.();
  });

  ctx.listen(slot, 'submit', async (e) => {
    const form = e.target.closest?.('[data-scene-form]');
    if (!form || !scene) return;
    e.preventDefault();
    const kind = form.dataset.sceneForm;
    busy(form, true);
    try {
      if (kind === 'edit') {
        const text = String(form.elements.namedItem('text')?.value || '').trim().slice(0, TEXT_MAX);
        if (!text) { flash('TEXT?', 'bad'); busy(form, false); return; }
        await api(`/api/arcs/scenes/${encodeURIComponent(scene.id)}/text`, { method: 'PUT', body: { text } });
        mode = null;
        await done('SCENE TEXT SAVED · EFFECTS UNCHANGED');
      } else if (kind === 'regen') {
        const tone = String(form.elements.namedItem('tone')?.value || '').trim().slice(0, TONE_MAX);
        const outcome = String(form.elements.namedItem('outcome')?.value || '');
        if (tone && !OUTCOME_WORDS.includes(outcome)) { flash(REFUSAL_WORDS.outcome_required, 'bad'); busy(form, false); return; }
        const r = await api(`/api/arcs/scenes/${encodeURIComponent(scene.id)}/regenerate`, { method: 'POST', body: tone ? { tone, outcome } : {} });
        mode = null;
        await done(r?.version ? `SCENE REWRITTEN · V${r.version}` : 'SCENE REWRITTEN', r?.sceneId ?? scene.id);
      } else if (kind === 'revert') {
        const reason = String(form.elements.namedItem('reason')?.value || '').trim().slice(0, REASON_MAX);
        const r = await api(`/api/life/events/${encodeURIComponent(scene.eventId)}/revert`, { method: 'POST', body: { reason } });
        mode = null;
        await done(r?.already ? 'THE SCENE WAS ALREADY REVERTED' : 'SCENE REVERTED · WITH WHAT IT CAUSED');
      }
    } catch (err) {
      if (isAbort(err)) return;
      flash(err.status === 429 ? 'TOO MANY · TRY AGAIN IN A MINUTE' : (refusalWords(err) ?? err.message), 'bad');
      // A refused / failed rewrite: reload, so the version line shows the failed attempt.
      if (ctx.alive() && kind === 'regen' && err.status === 409) { mode = null; deps.onChanged?.(); await show(id); return; }
      if (ctx.alive()) busy(form, false);
    }
  });

  return {
    show,
    clear() { id = null; scene = null; mode = null; if (slot) render(slot, html`<div class="empty">PICK A SCENE</div>`); },
    current: () => id,
  };
}
