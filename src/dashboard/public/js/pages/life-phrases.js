// LIFE · PHRASES (plan 020 H2): the code-written lines (thoughts, live lines, dream fragments) as they are today, beside what
// the file on disk has in his voice, so the owner can judge before the switch goes on. Reads GET /api/life/phrases and changes
// nothing; the switch itself is life.phraseBanks in Settings. Every string reaches the DOM through html``.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlot, $ } from '../core/dom.js';
import { showError } from '../components/ui.js';
import { flash } from '../components/flash.js';
import { kpi, segments, twoCol } from '../components/views.js';

const PAGE = 30;
const BANK_LABELS = { thought: 'Thoughts', live: 'Live lines', dream: 'Dreams' };
const ISSUES = {
  missing: 'No bank written yet: today\'s English is in use.',
  corrupt: 'The bank file is corrupted: today\'s English is in use.',
  too_big: 'The bank file is too big: today\'s English is in use.',
  unreadable: 'The bank file can\'t be read: today\'s English is in use.',
};
const WARNINGS = {
  partial: 'Only part of it was written. Lines without words stay English.',
  nothing_voiced: 'Nothing in it differs from the English.',
  english_changed_since: 'The English lines have changed since it was written. New lines stay English until the next run.',
};
export const warningText = (w) => {
  if (WARNINGS[w]) return WARNINGS[w];
  const m = /^one_language_(english|other):(\w+)$/.exec(String(w));
  if (m) return `${BANK_LABELS[m[2]] ?? m[2]} read as one language (${m[1] === 'english' ? 'nearly all English' : 'hardly any English'}). Fine if that is how he talks.`;
  return String(w);
};
export const issueText = (i) => ISSUES[i] ?? (String(i ?? '').startsWith('invalid:') ? `The bank file was refused (${String(i).slice(8)}): today's English is in use.` : (i ? String(i) : ''));
const versionWord = (b) => (b?.source === 'phrases.json' ? b.version : b?.source ? 'ENGLISH' : '—');
/** Which bank he speaks from, against the file these lines come from. */
export const activeText = (v) => {
  if (!v.running?.source) return `He isn't running a bank in this process: the file is ${versionWord(v.disk)}, and it loads when life starts.`;
  if (v.restartNeeded) return `Active: ${versionWord(v.running)}. The lines below are the file on disk, ${versionWord(v.disk)}. A restart applies it.`;
  return `Active: ${versionWord(v.running)}, the same as the file on disk.`;
};
export const tagsOf = (e) => ['mood', 'time', 'activity'].filter((k) => e[k]).map((k) => e[k]).join(' · ');

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">LIFE · PHRASES · HIS VOICE FOR THE CODE-WRITTEN LINES</div>
    <h1>Phrases</h1>
  </div>
  <div class="meta"><span>SWITCH <b data-slot="lp-switch">—</b></span><span>RUNNING <b data-slot="lp-running">—</b></span><span>ON DISK <b data-slot="lp-disk">—</b></span></div>
</div>
<div data-slot="lp-notes"></div>
<div class="kpi-grid" data-slot="lp-kpis"></div>
<div data-slot="lp-tabs"></div>
<div class="panel ph-search"><div class="panel-body">
  <label class="mute ph-q"><span>SEARCH</span> <input data-el="lp-q" type="search" maxlength="60" autocomplete="off" enterkeyhint="search"></label>
  <label class="mute ph-only"><input data-el="lp-only" type="checkbox"> ONLY LINES STILL IN ENGLISH</label>
</div></div>
<div data-slot="lp-rows"></div>
<div class="panel ph-pager"><div class="panel-body">
  <button class="btn" data-act="prev" type="button">NEWER</button>
  <button class="btn" data-act="next" type="button">MORE</button>
  <span class="mute" data-slot="lp-page"></span>
</div></div>`);

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  let bank = 'thought';
  let offset = 0;
  let asked = 0;       // typing fast: only the last answer paints
  let shown = false;   // once there are lines, a failed load keeps them and what was typed
  const load = async () => {
    const mine = ++asked;
    const q = $(root, '[data-el="lp-q"]')?.value.trim() ?? '';
    const only = $(root, '[data-el="lp-only"]')?.checked ? 'english' : '';
    let v;
    try {
      v = await api(`/api/life/phrases?bank=${encodeURIComponent(bank)}&q=${encodeURIComponent(q)}&only=${only}&offset=${offset}&limit=${PAGE}`, { signal: ctx.signal });
    } catch (err) {
      if (isAbort(err) || !ctx.alive() || mine !== asked) return;
      if (!shown) showError(root, err);
      else flash(`PHRASES: ${err.message}`, 'bad');
      return;
    }
    if (!ctx.alive() || mine !== asked) return;
    shown = true;
    const s = v.disk;
    setSlot(root, 'lp-switch', v.on ? 'ON' : 'OFF');
    setSlot(root, 'lp-running', versionWord(v.running));
    setSlot(root, 'lp-disk', versionWord(v.disk));
    const notes = [activeText(v), issueText(s.issue), ...(s.warnings ?? []).map(warningText)].filter(Boolean);
    if (!v.on) notes.unshift('The switch is off: he is using today\'s English. Turn it on in Settings (life.phraseBanks) when these read like him.');
    setSlot(root, 'lp-notes', html`<div class="panel"><div class="panel-body ph-notes">${notes.map((n) => html`<p class="mute">${n}</p>`)}</div></div>`);
    const cov = s.coverage?.[bank];
    const hl = s.health?.[bank];
    setSlot(root, 'lp-kpis', html`${kpi({ label: 'VOICED', value: cov ? `${cov.voiced}/${cov.slots}` : '—', sub: cov ? `${cov.entries} entries` : null })}
      ${kpi({ label: 'READS AS', value: hl?.language ?? '—', sub: hl ? `${hl.englishWordPct}% English-looking words` : null })}
      ${kpi({ label: 'DROPPED', value: String(Object.values(s.rejected ?? {}).reduce((a, b) => a + b, 0)), sub: Object.keys(s.rejected ?? {}).join(', ').replace(/_/g, ' ') || null })}
      ${kpi({ label: 'MOST USED', value: hl?.topWords?.[0]?.word ?? '—', sub: hl?.topWords?.slice(1, 6).map((w) => `${w.word} ${w.count}`).join(', ') || null })}`);
    setSlot(root, 'lp-tabs', segments(v.banks.map((b) => [b, BANK_LABELS[b] ?? b]), bank, { label: 'Banks' }));
    setSlot(root, 'lp-rows', v.rows.length
      ? html`${v.rows.map((r) => twoCol({
        title: r.pools[0], leftLabel: 'TODAY', left: r.source, rightLabel: v.restartNeeded ? 'HIS VOICE · ON DISK' : 'HIS VOICE', differs: r.variants.length > 0,
        right: r.variants.length ? html`${r.variants.map((e) => html`<div>${e.t}${tagsOf(e) ? html` <span class="mono mute">${tagsOf(e)}</span>` : ''}</div>`)}` : html`<span class="mute">stays as it is</span>`,
      }))}`
      : html`<div class="panel"><div class="panel-body mute">NOTHING MATCHES</div></div>`);
    setSlot(root, 'lp-page', `${v.total ? offset + 1 : 0}–${Math.min(offset + PAGE, v.total)} of ${v.total}`);
    const prev = $(root, '[data-act="prev"]');
    const next = $(root, '[data-act="next"]');
    if (prev) prev.disabled = offset === 0;
    if (next) next.disabled = offset + PAGE >= v.total;
  };
  ctx.listen(root, 'click', (ev) => {
    const seg = ev.target.closest?.('[data-seg]');
    if (seg) { ev.preventDefault(); bank = seg.dataset.seg; offset = 0; load(); return; }
    const act = ev.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'prev' || act === 'next') {
      offset = act === 'prev' ? Math.max(0, offset - PAGE) : offset + PAGE;
      load().then(() => {
        // From the buttons at the foot: back to the first line of the new page.
        const rows = $(root, '[data-slot="lp-rows"]');
        if (ctx.alive() && rows && rows.getBoundingClientRect().top < 0) rows.scrollIntoView({ block: 'start' });
      });
    }
  });
  let typing = null;
  ctx.listen(root, 'input', (ev) => {
    if (ev.target.dataset?.el !== 'lp-q') return;
    if (typing) clearTimeout(typing);
    typing = ctx.setTimeout(() => { offset = 0; load(); }, 300);
  });
  ctx.listen(root, 'change', (ev) => {
    if (ev.target.dataset?.el === 'lp-only') { offset = 0; load(); }
  });
  await load();
}
