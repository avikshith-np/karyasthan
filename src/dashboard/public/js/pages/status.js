// 01 STATUS — connection, uptime, memory, warmup, cooldowns, volume, routing.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, setSlots, setSlot, $ } from '../core/dom.js';
import { fmtDay, fmtDuration, fmtUsd, padz } from '../core/fmt.js';
import { buildAreaPath, flag, renderSparkbar, showError } from '../components/ui.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · STATUS · THE BOT RIGHT NOW</div>
    <h1>Status</h1>
  </div>
  <div class="meta">
    <span>PERSONA <b data-slot="persona">—</b></span>
    <span><span class="dot-live"></span> SOCKET <b data-slot="sock-state">—</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>CONNECTION</span></div>
    <div class="val" data-slot="status-conn">—</div>
    <div class="sub" data-slot="status-conn-sub">—</div>
  </div>
  <div class="kpi"><div class="lab"><span>UPTIME</span></div>
    <div class="val mono" data-slot="status-uptime">—</div>
    <div class="sub" data-slot="status-uptime-sub">since process boot</div>
  </div>
  <div class="kpi"><div class="lab"><span>MEMORY · RSS</span></div>
    <div class="val mono" data-slot="status-memory">—</div>
    <div class="sub" data-slot="status-memory-sub">—</div>
  </div>
  <div class="kpi" data-slot="status-warmup-card"><div class="lab"><span>WARMUP</span></div>
    <div class="val mono" data-slot="status-warmup">—</div>
    <div class="sub" data-slot="status-warmup-sub">—</div>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>VOLUME · 30D<button type="button" class="guide-q" data-guide="volume" aria-label="Guide: volume">?</button></span>
      <span class="mono" style="color:var(--ink-3)" data-slot="status-volume-summary">—</span>
    </div>
    <div class="chart">
      <svg viewBox="0 0 700 220" preserveAspectRatio="none">
        <defs>
          <linearGradient id="rxgrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#888" stop-opacity="0.4"/>
            <stop offset="1" stop-color="#888" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="txgrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#c8102e" stop-opacity="0.5"/>
            <stop offset="1" stop-color="#c8102e" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <g stroke="#232323" stroke-width="1">
          <line x1="0" y1="55" x2="700" y2="55"/><line x1="0" y1="110" x2="700" y2="110"/><line x1="0" y1="165" x2="700" y2="165"/>
        </g>
        <path data-slot="status-rx-fill" fill="url(#rxgrad)"></path>
        <path data-slot="status-rx-stroke" fill="none" stroke="#bbb" stroke-width="1.5"></path>
        <path data-slot="status-tx-fill" fill="url(#txgrad)"></path>
        <path data-slot="status-tx-stroke" fill="none" stroke="#c8102e" stroke-width="1.5"></path>
        <g font-family="JetBrains Mono" font-size="9" fill="#5a5a5a">
          <text x="2" y="50" data-slot="status-y-top">—</text>
          <text x="2" y="105" data-slot="status-y-mid">—</text>
          <text x="2" y="160" data-slot="status-y-bot">—</text>
          <text x="0" y="215" data-slot="status-x-from">—</text>
          <text x="640" y="215" data-slot="status-x-to">—</text>
        </g>
      </svg>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>COOLDOWNS · <b data-slot="status-cooldown-count">0</b> ACTIVE<button type="button" class="guide-q" data-guide="cooldowns" aria-label="Guide: cooldowns">?</button></span><span class="pill warn" data-slot="status-cooldown-pill" style="display:none">THROTTLE</span></div>
    <div class="row-list" data-slot="status-cooldowns">
      <div><span class="idx mono">--</span><div><div class="mute">No active cooldowns.</div></div><div></div></div>
    </div>
    <div class="panel-head" style="border-top:1px solid var(--line-2);border-bottom:none"><span>SLEEP WINDOW<button type="button" class="guide-q" data-guide="sleep" aria-label="Guide: sleep">?</button></span><span class="mono" data-slot="status-sleep">—</span></div>
  </div>
</div>

<div class="col-3" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>LLM · ROUTING<button type="button" class="guide-q" data-guide="routing" aria-label="Guide: routing">?</button></span><span class="mono mute" data-slot="status-llm-source">PRIMARY</span></div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-family:var(--font-mono);font-size: var(--t-meta)">
        <span class="mute">PROVIDER</span><b data-slot="status-llm-provider">—</b>
        <span class="mute">MODEL</span><b data-slot="status-llm-model">—</b>
        <span class="mute">TEMP</span><b data-slot="status-llm-temp">—</b>
        <span class="mute">MAX_TOK</span><b data-slot="status-llm-maxtok">—</b>
        <span class="mute">FALLBACK</span><b class="mute" data-slot="status-llm-fallback">—</b>
        <span class="mute">RATE</span><b data-slot="status-llm-rate">—</b>
      </div>
      <div class="cap mute" style="font-size: var(--t-label);margin:14px 0 6px">ROLES</div>
      <div class="table-wrap"><table class="data"><tbody data-slot="status-roles"></tbody></table></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>FLAGS<button type="button" class="guide-q" data-guide="flags" aria-label="Guide: flags">?</button></span><span class="mono mute">RUNTIME</span></div>
    <div class="panel-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-family:var(--font-mono);font-size: var(--t-meta)" data-slot="status-flags">
      <span class="mute">DRY_RUN</span><b>—</b>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>DAILY · LAST 7<button type="button" class="guide-q" data-guide="daily" aria-label="Guide: daily">?</button></span><span class="mono mute">SENT</span></div>
    <div class="panel-body">
      <div class="sparkbar" style="height:60px;align-items:flex-end" data-slot="status-sparkbar"></div>
      <div class="table-wrap"><table class="data" style="margin-top:10px"><tbody data-slot="status-daily"></tbody></table></div>
    </div>
  </div>
</div>
`);

const ROLE_STATE = { ok: 'ok', over: 'bad', none: '', disabled: '', shadow: 'warn' };

function paint(root, s, activity) {
  const tz = s.timezone || s.sleepWindow?.timezone || '';
  const mouth = s.roles?.mouth;
  setSlots(root, {
    persona: s.persona?.displayName || s.persona?.name || '—',
    'sock-state': s.connected ? 'OPEN' : 'CLOSED',
    'status-conn': s.connected ? 'ONLINE' : 'OFFLINE',
    'status-conn-sub': s.connected
      ? `WhatsApp Web · ${s.sockUser?.name || s.sockUser?.id || 'paired'}`
      : 'socket closed · awaiting pair',
    'status-uptime': fmtDuration(s.uptimeSec),
    'status-uptime-sub': 'since process boot',
    'status-memory': `${s.memoryMb?.rss}MB`,
    'status-memory-sub': `heap ${s.memoryMb?.heapUsed}MB · rss ${s.memoryMb?.rss}MB`,
    'status-sleep': `${padz(s.sleepWindow?.startHour ?? 0)}:00 → ${padz(s.sleepWindow?.endHour ?? 0)}:00 ${tz}`,
    'status-llm-provider': mouth?.provider || s.llm?.provider,
    'status-llm-model': mouth?.model || s.llm?.model,
    'status-llm-temp': s.llm?.temperature,
    'status-llm-maxtok': s.llm?.maxTokens,
    'status-llm-fallback': mouth?.fallback ? `${mouth.fallback.provider}/${mouth.fallback.model || '—'}` : 'none',
    'status-llm-rate': s.rateCaps ? `${s.rateCaps.perGroupHour}/group·h · ${s.rateCaps.globalHour}/h` : '—',
    'status-llm-source': `MOUTH · ${String(mouth?.provider || s.llm?.provider || '').toUpperCase()}`,
  });

  // Roles: provider/model + budget state per role.
  const roles = Object.entries(s.roles || {});
  setSlot(root, 'status-roles', roles.length
    ? roles.map(([name, r]) => html`<tr>
        <td class="mono">${name}</td>
        <td class="mono mute">${r.provider && r.model ? `${r.provider}/${r.model}` : '—'}</td>
        <td><span class="pill ${ROLE_STATE[r.state] ?? ''}">${r.state === 'none' ? 'no cap' : r.state}</span></td>
        <td class="num">${r.budgetUsd > 0 ? `${fmtUsd(r.spentUsd)} / ${fmtUsd(r.budgetUsd)}` : fmtUsd(r.spentUsd || 0)}</td>
      </tr>`)
    : html`<tr><td class="mute">no roles reported</td></tr>`);

  // Warmup
  const wuCard = $(root, '[data-slot="status-warmup-card"]');
  if (s.warmup?.tier) {
    wuCard?.classList.add('alert');
    const labSpan = wuCard?.querySelector('.lab span:first-child');
    if (labSpan) labSpan.textContent = `WARMUP · DAY ${s.warmup.day}`;
    setSlots(root, {
      'status-warmup': `${s.warmup.todayCount}`,
      'status-warmup-sub': `${s.warmup.todayCount} / ${s.warmup.tier.maxMsgsDay} today · TIER ${s.warmup.tier.tierIndex ?? '—'}${s.warmup.tier.tierCount ? `/${s.warmup.tier.tierCount}` : ''}`,
    });
    $(root, '[data-slot="status-warmup-sub"]')?.classList.add('red');
  } else {
    wuCard?.classList.remove('alert');
    setSlots(root, {
      'status-warmup': 'COMPLETE',
      'status-warmup-sub': `day ${s.warmup?.day ?? '—'} · no throttle`,
    });
  }

  // Cooldowns
  const cooldowns = s.cooldowns || [];
  setSlots(root, { 'status-cooldown-count': cooldowns.length });
  const cdPill = $(root, '[data-slot="status-cooldown-pill"]');
  if (cdPill) cdPill.style.display = cooldowns.length ? '' : 'none';
  setSlot(root, 'status-cooldowns', cooldowns.length
    ? cooldowns.map((c, i) => {
      const sec = c.secondsRemaining ?? 0;
      return html`<div>
        <span class="idx">${padz(i + 1)}</span>
        <div><div class="name">${c.name || 'group'}</div><div class="mono mute" style="font-size: var(--t-label)">${c.jid || ''}</div></div>
        <div class="mono ${sec > 60 ? 'red-bright' : 'amber'} tnum">${sec}s</div>
      </div>`;
    })
    : html`<div><span class="idx mono">--</span><div><div class="mute">No active cooldowns.</div></div><div></div></div>`);

  // Flags
  const flags = [
    ['DRY_RUN', s.dryRun], ['READ_ONLY', s.readOnly], ['WARMUP', s.toggles?.warmup],
    ['QUALITY_GATE', s.toggles?.qualityGate], ['IMAGE_GEN', s.toggles?.imageGen], ['VOICE_NOTE', s.toggles?.voiceNote],
  ];
  setSlot(root, 'status-flags', html`${flags.map(([k, v]) => html`<span class="mute">${k}</span>${flag(v)}`)}<span class="mute">TZ</span><b>${tz || '—'}</b>`);

  // Volume chart (30 days)
  const rx = activity.map((r) => Number(r.human_count || 0));
  const tx = activity.map((r) => Number(r.self_count || 0));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  setSlot(root, 'status-volume-summary', html`RECEIVED <b style="color:var(--ink-1)">${sum(rx).toLocaleString()}</b> · SENT <b style="color:var(--red-bright)">${sum(tx).toLocaleString()}</b>`);
  if (rx.length) {
    // One shared scale: RX and TX are drawn against the same maximum, so their heights compare.
    const shared = Math.max(1, ...rx, ...tx);
    const a = buildAreaPath(rx, 700, 220, 30, 200, shared);
    const b = buildAreaPath(tx, 700, 220, 30, 200, shared);
    $(root, '[data-slot="status-rx-fill"]')?.setAttribute('d', a.fill);
    $(root, '[data-slot="status-rx-stroke"]')?.setAttribute('d', a.line);
    $(root, '[data-slot="status-tx-fill"]')?.setAttribute('d', b.fill);
    $(root, '[data-slot="status-tx-stroke"]')?.setAttribute('d', b.line);
    setSlots(root, {
      'status-y-top': a.max,
      'status-y-mid': Math.round(a.max / 2),
      'status-y-bot': '0',
      'status-x-from': activity[0]?.day || '—',
      'status-x-to': activity[activity.length - 1]?.day || '—',
    });
  }

  // Daily sends (warmup counters are keyed by day in the bot's timezone; it keeps 7 days)
  const last7 = Object.entries(s.warmup?.dailyCounts || {}).sort().slice(-7);
  renderSparkbar($(root, '[data-slot="status-sparkbar"]'), last7.map(([, v]) => Number(v) || 0), 3);
  const today = fmtDay();
  setSlot(root, 'status-daily', last7.map(([day, count]) => {
    const isToday = day === today;
    return html`<tr class="${isToday ? 'self' : ''}"><td class="mono ${isToday ? '' : 'mute'}">${day}</td><td class="num">${isToday && s.warmup?.tier
      ? html`<b>${count}</b> <span class="mute">/${s.warmup.tier.maxMsgsDay}</span>` : count}</td></tr>`;
  }));
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const load = async () => {
    const [s, activity] = await Promise.all([
      api('/api/status', { signal: ctx.signal }),
      api('/api/stats/activity?days=30', { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return []; }),
    ]);
    if (ctx.alive()) paint(root, s, Array.isArray(activity) ? activity : []);
  };
  try {
    await load();
  } catch (err) {
    if (!isAbort(err) && ctx.alive()) showError(root, err);
    return;
  }
  ctx.setInterval(() => { load().catch(() => {}); }, 30_000);
}
