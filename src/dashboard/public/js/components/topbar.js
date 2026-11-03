// Topbar: uptime, response rate, ticker of runtime flags, and a clock in the
// bot's timezone (status.timezone via Intl — no zone literal here).
import { api } from '../core/api.js';
import { html, render } from '../core/dom.js';
import { fmtClock, fmtDuration, fmtHm, padz, setTimezone, zoneLabel } from '../core/fmt.js';

let lastStatus = null;
const listeners = new Set();

/** Latest /api/status (refreshed every 30 s). */
export const getStatus = () => lastStatus;
/** Called with every fresh status. Returns an unsubscribe. */
export function onStatus(fn) {
  listeners.add(fn);
  if (lastStatus) { try { fn(lastStatus); } catch {} }
  return () => listeners.delete(fn);
}

const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

function tick() {
  set('clockLocal', lastStatus ? fmtClock() : '—');
  set('clockZone', lastStatus ? zoneLabel() : '');
}

function paintTicker(s, cfg) {
  const cooldownTxt = `COOLDOWN ${s.cooldowns?.length || 0}`;
  const sleepTxt = `SLEEP ${padz(s.sleepWindow?.startHour ?? 0)}:00–${padz(s.sleepWindow?.endHour ?? 0)}:00`;
  const warmupTxt = s.warmup?.tier
    ? `WARMUP D${s.warmup.day} · ${s.warmup.todayCount}/${s.warmup.tier.maxMsgsDay}`
    : 'WARMUP COMPLETE';
  const mouth = s.roles?.mouth;
  const budget = s.budget;
  const items = [
    html`<span>▸ MEM_RSS <b>${s.memoryMb?.rss}MB</b></span>`,
    html`<span>▸ TEMP <b>${s.llm?.temperature}</b></span>`,
    html`<span>▸ MOUTH <b>${mouth ? `${mouth.provider}/${mouth.model}` : s.llm?.model}</b></span>`,
    budget && budget.budgetUsd > 0 ? html`<span class="${budget.state === 'over' ? 'red' : ''}">▸ BUDGET <b>$${Number(budget.spentUsd || 0).toFixed(2)} / $${budget.budgetUsd}</b></span>` : null,
    html`<span class="${s.cooldowns?.length ? 'red' : ''}">▸ ${cooldownTxt}</span>`,
    html`<span>▸ ${sleepTxt} ${s.timezone || s.sleepWindow?.timezone || ''}</span>`,
    html`<span class="red">▸ ${warmupTxt}</span>`,
    html`<span>▸ DRY_RUN <b>${s.dryRun ? 'ON' : 'off'}</b></span>`,
    html`<span>▸ READ_ONLY <b>${s.readOnly ? 'ON' : 'off'}</b></span>`,
    html`<span>▸ SOCK <b>${s.connected ? 'OPEN' : 'DOWN'}</b></span>`,
  ];
  // Rendered twice back to back for the scrolling ticker; the copy is hidden from AT.
  render(document.getElementById('tickerTrack'), html`<span class="ticker-run">${items}</span><span class="ticker-run" aria-hidden="true">${items}</span>`);
  if (cfg?.values) set('topRate', String(cfg.values.responseRate ?? '—'));
}

// Spec 009: availability badge from status.life (hidden while the engine is not running).
function paintLife(s) {
  const cell = document.getElementById('lifeCell');
  if (!cell) return;
  const l = s?.life;
  if (!l?.enabled || !l.availability) { cell.hidden = true; return; }
  cell.hidden = false;
  const until = l.until ? ` · ${fmtHm(l.until)}` : '';
  set('topLife', `${String(l.availability).toUpperCase()}${until}`);
  cell.dataset.av = l.availability;
  cell.title = `Life: ${l.availability}${l.activity ? ` (${l.activity})` : ''}${l.until ? ` until ${fmtHm(l.until)}` : ''}${l.onPhone ? ' · on phone' : ''}`;
  // 020 E1: open plot-hole findings (Life · Now → PLOT HOLES).
  const alerts = Number.isFinite(l.alerts) ? l.alerts : 0;
  const badge = document.getElementById('topLifeAlerts');
  if (badge) { badge.hidden = alerts < 1; badge.textContent = alerts < 1 ? '' : ` · ${alerts} ALERT${alerts === 1 ? '' : 'S'}`; }
}

export async function refreshTopbar() {
  try {
    const [s, cfg] = await Promise.all([api('/api/status'), api('/api/config').catch(() => null)]);
    lastStatus = s;
    setTimezone(s.timezone || s.sleepWindow?.timezone);
    set('topUptime', fmtDuration(s.uptimeSec));
    paintTicker(s, cfg);
    paintLife(s);
    for (const fn of [...listeners]) { try { fn(s); } catch {} }
  } catch {
    set('topUptime', '—');
  }
  tick();
  return lastStatus;
}

let timers = [];
export function startTopbar() {
  tick();
  timers.push(setInterval(tick, 1000));
  timers.push(setInterval(refreshTopbar, 30_000));
  return refreshTopbar();
}
export function stopTopbar() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
