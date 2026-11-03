// Provenance views shared by the person and memories pages (spec 006): where an
// item was learned, and who an owner note may be heard by.
import { html } from '../core/dom.js';

export const VISIBILITY_LABELS = Object.freeze({
  subject_dm: 'their DM only',
  subject_groups: 'DM + their groups',
  everywhere: 'everywhere',
});

/** Origin kind chip (dm/call highlighted) + where it was learned. */
export function originCell(row) {
  const kind = row?.origin_kind || '?';
  const cls = kind === 'dm' || kind === 'call' ? 'chip warn' : 'chip';
  return html`<span class="${cls}">${kind}</span> <span class="mute" title="${row?.origin_jid || ''}">${row?.origin_label || row?.origin_jid || '—'}</span>`;
}
