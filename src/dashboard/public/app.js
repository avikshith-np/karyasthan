// Brutalist surveillance dashboard. Hash router + per-page renderers wired
// to the existing /api/* surface. No build step.

// ────── helpers ─────────────────────────────────────────────────────────

const readCookie = (name) => {
  const hit = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const api = async (path, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  if (WRITE_METHODS.has(method)) {
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts = { ...opts, body: JSON.stringify(opts.body) };
    }
  }
  const res = await fetch(path, { credentials: 'include', ...opts, headers });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const body = await res.json(); if (body?.error) msg = `${res.status}: ${body.error}`; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
};

// Convert cached basic-auth into a 30-day session cookie + CSRF cookie.
fetch('/api/login', { method: 'POST', credentials: 'include' }).catch(() => {});

const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date((typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts));
  return d.toLocaleString();
};

const fmtRelative = (ts) => {
  if (!ts) return '—';
  const sec = Math.floor(Date.now() / 1000) - (typeof ts === 'number' && ts < 1e12 ? ts : Math.floor(ts / 1000));
  if (sec < 0) return 'now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
};

const fmtDuration = (sec) => {
  if (!sec && sec !== 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600), d = Math.floor(h / 24);
  if (d < 1) return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${d}d ${h % 24}h`;
};

const padz = (n, w = 2) => String(n).padStart(w, '0');

const maskPhone = (phone) => {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return digits;
  return digits.slice(0, digits.length - 5) + ' ▓▓▓▓▓';
};

function flash(msg, type = 'ok', ms = 3500) {
  const bar = el('div', { class: `flash ${type}` }, msg);
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), ms);
}

const setSlots = (root, map) => {
  for (const [key, val] of Object.entries(map)) {
    const node = root.querySelector(`[data-slot="${key}"]`);
    if (!node) continue;
    if (val instanceof Node) { node.innerHTML = ''; node.appendChild(val); }
    else if (val == null) node.textContent = '—';
    else node.textContent = String(val);
  }
};

const setSlotHtml = (root, key, html) => {
  const node = root.querySelector(`[data-slot="${key}"]`);
  if (node) node.innerHTML = html;
};

// ────── chrome state: streams, status cache, clock ──────────────────────

let activeStreams = [];
function trackStream(es) { activeStreams.push(es); return es; }
function closeAllStreams() {
  for (const es of activeStreams) { try { es.close(); } catch {} }
  activeStreams = [];
}

let cachedStatus = null;
let cachedStatusAt = 0;
async function getStatus(forceRefresh = false) {
  if (!forceRefresh && cachedStatus && Date.now() - cachedStatusAt < 5000) return cachedStatus;
  cachedStatus = await api('/api/status');
  cachedStatusAt = Date.now();
  return cachedStatus;
}

let cachedConfig = null;
async function getConfig(forceRefresh = false) {
  if (!forceRefresh && cachedConfig) return cachedConfig;
  cachedConfig = await api('/api/config');
  return cachedConfig;
}

// Live clock + frame counter
let frameNo = 0;
function tickClock() {
  const d = new Date();
  const ist = new Date(d.getTime() + (5.5 * 3600 - d.getTimezoneOffset() * 60) * 1000);
  const local = `${padz(ist.getUTCHours())}:${padz(ist.getUTCMinutes())}:${padz(ist.getUTCSeconds())}`;
  const f = padz(frameNo, 6);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('clockLocal', local);
  set('frameNo', f);
  set('frameTwo', f);
  frameNo++;
}

async function refreshTopbar() {
  try {
    const s = await getStatus(true);
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('topUptime', fmtDuration(s.uptimeSec));
    const cooldownTxt = s.cooldowns?.length ? `COOLDOWN ${s.cooldowns.length}` : 'COOLDOWN 0';
    const sleepTxt = `SLEEP ${padz(s.sleepWindow.startHour)}:00–${padz(s.sleepWindow.endHour)}:00`;
    const warmupTxt = s.warmup?.tier
      ? `WARMUP D${s.warmup.day} · ${s.warmup.todayCount}/${s.warmup.tier.maxMsgsDay}`
      : `WARMUP COMPLETE`;
    const ticker = [
      ['MEM_RSS', `<b>${s.memoryMb.rss}MB</b>`],
      ['TEMP', `<b>${s.llm.temperature}</b>`],
      ['MAX_TOK', `<b>${s.llm.maxTokens}</b>`],
      ['MODEL', `<b>${escapeHtml(s.llm.model)}</b>`],
      [null, `<span class="${s.cooldowns?.length ? 'red' : ''}">▸ ${cooldownTxt}</span>`],
      [null, `<span>▸ ${sleepTxt} ${escapeHtml(s.sleepWindow.timezone)}</span>`],
      [null, `<span class="red">▸ ${warmupTxt}</span>`],
      ['DRY_RUN', `<b>${s.dryRun ? 'ON' : 'off'}</b>`],
      ['READ_ONLY', `<b>${s.readOnly ? 'ON' : 'off'}</b>`],
      ['SOCK', `<b>${s.connected ? 'OPEN' : 'DOWN'}</b>`],
    ];
    const items = ticker.map(([k, v]) => k ? `<span>▸ ${k} ${v}</span>` : `<span>${v}</span>`).join('');
    const track = document.getElementById('tickerTrack');
    if (track) track.innerHTML = items + items; // repeat for ticker animation

    try {
      const cfg = await getConfig();
      set('topRate', String(cfg.values?.responseRate ?? '—'));
    } catch {}

    const ip = document.getElementById('uplinkIp');
    if (ip && cachedConfig?.values?.dashboard) {
      const d = cachedConfig.values.dashboard;
      ip.textContent = `${d.host || '127.0.0.1'}:${d.port || 7070}`;
    }
  } catch {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('topUptime', '—');
  }
}

// ────── chart helpers ───────────────────────────────────────────────────

function buildAreaPath(values, w = 700, h = 220, top = 0, bottom = 220) {
  const n = values.length;
  if (!n) return '';
  const max = Math.max(1, ...values);
  const stepX = w / Math.max(n - 1, 1);
  const range = bottom - top;
  const pts = values.map((v, i) => {
    const x = +(i * stepX).toFixed(1);
    const y = +(bottom - (v / max) * range).toFixed(1);
    return `${x},${y}`;
  });
  const linePath = `M${pts.join(' L')}`;
  const fillPath = `${linePath} L${w},${bottom} L0,${bottom} Z`;
  return { line: linePath, fill: fillPath, max };
}

function renderSparkbar(container, values, hiCount = 3) {
  if (!container) return;
  container.innerHTML = '';
  if (!values.length) return;
  const max = Math.max(1, ...values);
  const sortedDesc = [...values].sort((a, b) => b - a);
  const hiThreshold = sortedDesc[Math.min(hiCount, sortedDesc.length) - 1] ?? 0;
  for (const v of values) {
    const pct = Math.max(2, Math.round((v / max) * 100));
    const span = document.createElement('span');
    span.style.height = pct + '%';
    if (v > 0 && v >= hiThreshold) span.className = 'hi';
    container.appendChild(span);
  }
}

// ────── per-page renderers ──────────────────────────────────────────────

function showShell(name) {
  const root = document.getElementById('content');
  root.innerHTML = window.PAGES[name] || `<div class="empty">PAGE NOT FOUND: ${escapeHtml(name)}</div>`;
  return root;
}

function showError(root, err) {
  root.innerHTML = `<div class="empty" style="color:var(--red-bright)">ERROR · ${escapeHtml(err.message || String(err))}</div>`;
}

// ── 01 STATUS ──
async function renderStatus() {
  const root = showShell('status');
  try {
    const [s, activity] = await Promise.all([
      getStatus(true),
      api('/api/stats/activity?days=30').catch(() => []),
    ]);

    setSlots(root, {
      'sock-state': s.connected ? 'OPEN' : 'CLOSED',
      'status-conn': s.connected ? 'ONLINE' : 'OFFLINE',
      'status-conn-sub': s.connected
        ? `WhatsApp Web · ${s.sockUser?.name || s.sockUser?.id || 'paired'}`
        : 'socket closed · awaiting pair',
      'status-uptime': fmtDuration(s.uptimeSec),
      'status-uptime-sub': `since process boot · pid online`,
      'status-memory': `${s.memoryMb.rss}MB`,
      'status-memory-sub': `heap ${s.memoryMb.heapUsed}MB · rss ${s.memoryMb.rss}MB`,
      'status-sleep': `${padz(s.sleepWindow.startHour)}:00 → ${padz(s.sleepWindow.endHour)}:00 ${s.sleepWindow.timezone}`,
      'status-llm-provider': s.llm.provider,
      'status-llm-model': s.llm.model,
      'status-llm-temp': s.llm.temperature,
      'status-llm-maxtok': s.llm.maxTokens,
      'status-llm-fallback': '—',
      'status-llm-rate': '—',
      'status-llm-source': `PRIMARY · ${(s.llm.provider || '').toUpperCase()}`,
    });

    // warmup
    const wuCard = root.querySelector('[data-slot="status-warmup-card"]');
    if (s.warmup?.tier) {
      wuCard?.classList.add('alert');
      const labSpan = wuCard?.querySelector('.lab span:first-child');
      if (labSpan) labSpan.textContent = `WARMUP · DAY ${s.warmup.day}`;
      setSlots(root, {
        'status-warmup': `${s.warmup.todayCount}`,
        'status-warmup-sub': `${s.warmup.todayCount} / ${s.warmup.tier.maxMsgsDay} today · TIER ${s.warmup.tier.tierIndex ?? s.warmup.tier.maxMsgsDay}`,
      });
      const sub = root.querySelector('[data-slot="status-warmup-sub"]');
      if (sub) sub.classList.add('red');
    } else {
      wuCard?.classList.remove('alert');
      setSlots(root, {
        'status-warmup': 'COMPLETE',
        'status-warmup-sub': `day ${s.warmup?.day ?? '—'} · no throttle`,
      });
    }

    // cooldowns
    const cdSlot = root.querySelector('[data-slot="status-cooldowns"]');
    const cdPill = root.querySelector('[data-slot="status-cooldown-pill"]');
    setSlots(root, { 'status-cooldown-count': s.cooldowns.length });
    if (cdPill) cdPill.style.display = s.cooldowns.length ? '' : 'none';
    if (cdSlot) {
      cdSlot.innerHTML = '';
      if (!s.cooldowns.length) {
        cdSlot.appendChild(el('div', {},
          el('span', { class: 'idx mono' }, '--'),
          el('div', {}, el('div', { class: 'mute' }, 'No active cooldowns.')),
          el('div', {}),
        ));
      } else {
        s.cooldowns.forEach((c, i) => {
          const sec = c.secondsRemaining ?? 0;
          const colour = sec > 60 ? 'red-bright' : 'amber';
          cdSlot.appendChild(el('div', {},
            el('span', { class: 'idx' }, padz(i + 1)),
            el('div', {},
              el('div', { class: 'name' }, c.name || 'group'),
              el('div', { class: 'mono mute', style: 'font-size:10px' }, c.jid || ''),
            ),
            el('div', { class: `mono ${colour} tnum` }, `${sec}s`),
          ));
        });
      }
    }

    // FLAGS
    const flags = root.querySelector('[data-slot="status-flags"]');
    if (flags) {
      const rows = [
        ['DRY_RUN', s.dryRun, true],
        ['READ_ONLY', s.readOnly, true],
        ['WARMUP', s.toggles?.warmup, true],
        ['QUALITY_GATE', s.toggles?.qualityGate, true],
        ['IMAGE_GEN', s.toggles?.imageGen, true],
        ['VOICE_NOTE', s.toggles?.voiceNote, true],
        ['TZ', s.sleepWindow.timezone, false],
      ];
      flags.innerHTML = rows.map(([k, v, isBool]) => {
        if (!isBool) return `<span class="mute">${k}</span><b>${escapeHtml(v ?? '—')}</b>`;
        const cls = v ? 'amber' : 'green';
        const mark = v ? '▣ ON' : '▢ off';
        return `<span class="mute">${k}</span><b class="${cls}">${mark}</b>`;
      }).join('');
    }

    // Volume chart from activity
    const rxValues = activity.map(r => Number(r.human_count || 0));
    const txValues = activity.map(r => Number(r.self_count || 0));
    const totalRx = rxValues.reduce((a, b) => a + b, 0);
    const totalTx = txValues.reduce((a, b) => a + b, 0);
    setSlotHtml(root, 'status-volume-summary',
      `RX <b style="color:var(--ink-1)">${totalRx.toLocaleString()}</b> · TX <b style="color:var(--red-bright)">${totalTx.toLocaleString()}</b>`);

    if (rxValues.length) {
      const rx = buildAreaPath(rxValues, 700, 220, 30, 200);
      const tx = buildAreaPath(txValues, 700, 220, 30, 200);
      root.querySelector('[data-slot="status-rx-fill"]')?.setAttribute('d', rx.fill);
      root.querySelector('[data-slot="status-rx-stroke"]')?.setAttribute('d', rx.line);
      root.querySelector('[data-slot="status-tx-fill"]')?.setAttribute('d', tx.fill);
      root.querySelector('[data-slot="status-tx-stroke"]')?.setAttribute('d', tx.line);
      const max = rx.max;
      setSlots(root, {
        'status-y-top': max,
        'status-y-mid': Math.round(max / 2),
        'status-y-bot': '0',
        'status-x-from': activity[0]?.day || '—',
        'status-x-to': activity[activity.length - 1]?.day || '—',
      });
    }

    // Daily 7
    const dailyEntries = Object.entries(s.warmup?.dailyCounts || {}).sort();
    const last7 = dailyEntries.slice(-14);
    const sparkValues = last7.map(([, v]) => Number(v) || 0);
    renderSparkbar(root.querySelector('[data-slot="status-sparkbar"]'), sparkValues, 3);
    const dailyTbody = root.querySelector('[data-slot="status-daily"]');
    if (dailyTbody) {
      dailyTbody.innerHTML = '';
      const today = new Date().toISOString().slice(0, 10);
      for (const [day, count] of last7.slice(-7)) {
        const isSelf = day === today;
        dailyTbody.innerHTML += `<tr${isSelf ? ' class="self"' : ''}><td class="mono ${isSelf ? '' : 'mute'}">${escapeHtml(day)}</td><td class="num">${isSelf && s.warmup?.tier ? `<b>${count}</b> <span class="mute">/${s.warmup.tier.maxMsgsDay}</span>` : count}</td></tr>`;
      }
    }
  } catch (err) { showError(root, err); }
}

// ── 02 GROUPS ──
async function renderGroups() {
  const root = showShell('groups');
  try {
    const groups = await api('/api/groups');
    const total = groups.length;
    const muted = groups.filter(g => g.muted).length;
    const active = total - muted;
    setSlots(root, {
      'groups-total': total,
      'groups-active': active,
      'groups-muted': muted,
      'groups-sort': `SORTED · LAST_ACTIVE DESC · ${total}`,
    });

    // Build vibe filter dropdown — only treat short, delimited fragments as chips
    const vibeChunks = (vibe) => {
      if (!vibe) return [];
      const parts = vibe.split(/[,·•|]/).map(s => s.trim()).filter(Boolean);
      // If every chunk is short and there are 2+, treat as tag list
      if (parts.length >= 2 && parts.every(p => p.length <= 24)) return parts;
      return [vibe];
    };
    const vibeSel = root.querySelector('#groupsVibeFilter');
    const vibesSeen = new Set();
    for (const g of groups) for (const v of vibeChunks(g.vibe)) if (v.length <= 24) vibesSeen.add(v);
    if (vibeSel) {
      for (const v of [...vibesSeen].sort()) {
        const o = document.createElement('option'); o.value = v; o.textContent = v.toUpperCase();
        vibeSel.appendChild(o);
      }
    }

    const tbody = root.querySelector('[data-slot="groups-rows"]');
    const filterInput = root.querySelector('#groupsFilter');

    function renderRows() {
      const q = (filterInput?.value || '').toLowerCase();
      const vibeF = (vibeSel?.value || '').toLowerCase();
      tbody.innerHTML = '';
      let i = 1;
      for (const g of groups) {
        const text = `${g.name || ''} ${g.jid} ${g.vibe || ''}`.toLowerCase();
        if (q && !text.includes(q)) continue;
        if (vibeF && !(g.vibe || '').toLowerCase().includes(vibeF)) continue;
        const chunks = vibeChunks(g.vibe);
        const vibeCell = !g.vibe
          ? '<span class="mute">—</span>'
          : chunks.length > 1
            ? chunks.map(v => `<span class="chip">${escapeHtml(v)}</span>`).join('')
            : `<span class="mute mono" style="font-size:10px" title="${escapeHtml(g.vibe)}">${escapeHtml(g.vibe.slice(0, 60))}${g.vibe.length > 60 ? '…' : ''}</span>`;
        const stateHtml = g.muted
          ? `<span class="pill bad">MUTED</span>`
          : `<span class="pill ok">ACTIVE</span>`;
        const jidShort = g.jid?.length > 20 ? '…' + g.jid.slice(-12) : g.jid;
        const link = `#group/${encodeURIComponent(g.jid)}`;
        tbody.innerHTML += `
          <tr>
            <td class="id">${padz(i, 2)}</td>
            <td><b><a href="${link}">${escapeHtml(g.name || g.jid)}</a></b></td>
            <td class="id">${escapeHtml(jidShort || '—')}</td>
            <td>${vibeCell}</td>
            <td class="num">${g.memberCount ?? '—'}</td>
            <td class="num">${(g.messageCount || 0).toLocaleString()}</td>
            <td class="mono mute">${fmtRelative(g.lastActive)}</td>
            <td>${stateHtml}</td>
          </tr>`;
        i++;
      }
      if (!tbody.children.length) tbody.innerHTML = `<tr><td colspan="8" class="empty">NO MATCHES</td></tr>`;
    }

    filterInput?.addEventListener('input', renderRows);
    vibeSel?.addEventListener('change', renderRows);
    renderRows();
  } catch (err) { showError(root, err); }
}

// ── 02.B GROUP DETAIL ──
async function renderGroupDetail(jid) {
  const root = showShell('groupDetail');
  try {
    const g = await api(`/api/groups/${encodeURIComponent(jid)}`);
    setSlots(root, {
      'gd-name': g.name || g.jid,
      'gd-jid': g.jid,
      'gd-state': g.muted ? '' : '',
    });
    setSlotHtml(root, 'gd-state', g.muted ? `<span class="pill bad">MUTED</span>` : `<span class="pill ok">ACTIVE</span>`);

    // Meta
    const metaSlot = root.querySelector('[data-slot="gd-meta"]');
    if (metaSlot) {
      metaSlot.innerHTML = [
        ['JID', g.jid],
        ['NAME', g.name || '—'],
        ['VIBE', g.vibe || '—'],
        ['LANG', g.language || '—'],
        ['MEMBERS', `${g.members?.length || 0} active`],
        ['AVG_MSG_HR', g.avg_messages_hr ?? g.avgMessagesHr ?? '—'],
        ['LAST_ACTIVE', fmtRelative(g.last_active || g.lastActive)],
        ['JOINED', fmtTime(g.joined_at || g.joinedAt)],
      ].map(([k, v]) => `<span class="mute">${k}</span><b>${escapeHtml(v)}</b>`).join('');
    }

    // Slang
    const slangSlot = root.querySelector('[data-slot="gd-slang"]');
    if (slangSlot) {
      slangSlot.innerHTML = (g.slang || []).length
        ? g.slang.map(s => `<span class="chip">${escapeHtml(s.term)}${s.use_count > 1 ? ' · ' + s.use_count : ''}</span>`).join('')
        : '<span class="mute mono">—</span>';
    }

    // Controls
    const ctrlSlot = root.querySelector('[data-slot="gd-controls"]');
    if (ctrlSlot) {
      ctrlSlot.innerHTML = `
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="text" id="gdVibe" placeholder="vibe" value="${escapeHtml(g.vibe || '')}" style="flex:1;min-width:200px" />
          <button id="gdSaveVibe">SAVE VIBE</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${g.muted
            ? `<button class="danger" id="gdUnmute">UNMUTE</button>`
            : `<input type="number" id="gdMuteMin" placeholder="min · blank=∞" style="width:14ch" /><button class="danger" id="gdMute">MUTE</button>`}
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="text" id="gdForceText" placeholder="optional · exact text" style="flex:1;min-width:200px" />
          <button class="primary" id="gdForce">FORCE REPLY</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button id="gdSendSticker">▸ SEND STICKER</button>
          <button id="gdSendGif">▸ SEND GIF</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="text" id="gdForceVoiceText" placeholder="optional · text to speak (blank = LLM reply)" style="flex:1;min-width:200px" />
          <label class="mono mute" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="gdVoiceSing" /> SING</label>
          <button id="gdSendVoice">▸ SEND VOICE</button>
        </div>
      `;
      ctrlSlot.querySelector('#gdSaveVibe')?.addEventListener('click', async () => {
        try { await api(`/api/groups/${encodeURIComponent(g.jid)}`, { method: 'PATCH', body: { vibe: ctrlSlot.querySelector('#gdVibe').value } });
          flash('VIBE UPDATED'); } catch (e) { flash(e.message, 'bad'); }
      });
      ctrlSlot.querySelector('#gdUnmute')?.addEventListener('click', async () => {
        try { await api(`/api/groups/${encodeURIComponent(g.jid)}/unmute`, { method: 'POST', body: {} });
          flash('UNMUTED'); renderGroupDetail(jid); } catch (e) { flash(e.message, 'bad'); }
      });
      ctrlSlot.querySelector('#gdMute')?.addEventListener('click', async () => {
        const min = ctrlSlot.querySelector('#gdMuteMin').value;
        try { await api(`/api/groups/${encodeURIComponent(g.jid)}/mute`, { method: 'POST', body: min ? { durationMinutes: Number(min) } : {} });
          flash('MUTED'); renderGroupDetail(jid); } catch (e) { flash(e.message, 'bad'); }
      });
      ctrlSlot.querySelector('#gdForce')?.addEventListener('click', async (e) => {
        const btn = e.target; btn.disabled = true;
        const text = ctrlSlot.querySelector('#gdForceText').value.trim();
        try { const res = await api(`/api/groups/${encodeURIComponent(g.jid)}/respond`, { method: 'POST', body: text ? { text } : {} });
          flash(`SENT · ${(res.text || '').slice(0, 80)}`); renderGroupDetail(jid); }
        catch (err) { flash(err.message, 'bad'); btn.disabled = false; }
      });
      const mediaBtn = (sel, kind) => ctrlSlot.querySelector(sel)?.addEventListener('click', async (e) => {
        const btn = e.target; btn.disabled = true;
        try { const res = await api(`/api/groups/${encodeURIComponent(g.jid)}/send-${kind}`, { method: 'POST', body: {} });
          flash(`${kind.toUpperCase()} SENT · query=${res.query || '?'}`); btn.disabled = false; }
        catch (err) { flash(err.message, 'bad'); btn.disabled = false; }
      });
      mediaBtn('#gdSendSticker', 'sticker');
      mediaBtn('#gdSendGif', 'gif');
      ctrlSlot.querySelector('#gdSendVoice')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const label = btn.textContent;
        const text = ctrlSlot.querySelector('#gdForceVoiceText').value.trim();
        const sing = !!ctrlSlot.querySelector('#gdVoiceSing')?.checked;
        const body = {}; if (text) body.text = text; if (sing) body.sing = true;
        // Blank text => the server runs a full LLM generation + Gemini TTS + ffmpeg, which is
        // slow; cap the wait so a stalled LLM can't leave the button stuck disabled forever.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        btn.disabled = true; btn.textContent = '▸ SENDING…';
        try {
          const res = await api(`/api/groups/${encodeURIComponent(g.jid)}/send-voice`, { method: 'POST', body, signal: ctrl.signal });
          flash(`VOICE SENT · ${res.duration ?? '?'}s · ${(res.text || '').slice(0, 50)}`);
        } catch (err) {
          flash(ctrl.signal.aborted ? 'Voice send timed out — LLM/TTS too slow' : err.message, 'bad');
        } finally {
          clearTimeout(timer); btn.disabled = false; btn.textContent = label;
        }
      });
    }

    // Members
    const memBody = root.querySelector('[data-slot="gd-members"]');
    setSlots(root, { 'gd-member-count': g.members?.length || 0 });
    if (memBody) {
      memBody.innerHTML = (g.members || []).map(m => {
        const link = `#person/${encodeURIComponent(m.person_jid)}`;
        const name = m.real_name || m.push_name || m.person_jid;
        return `<tr><td><a href="${link}"><b>${escapeHtml(name)}</b></a></td><td class="mono mute">${escapeHtml(m.role || '—')}</td><td class="mute">${escapeHtml((m.summary || '').slice(0, 60))}</td></tr>`;
      }).join('') || '<tr><td colspan="3" class="empty">NO MEMBERS</td></tr>';
    }

    // Recent messages
    const msgBody = root.querySelector('[data-slot="gd-messages"]');
    if (msgBody) {
      const rows = (g.recentMessages || []).slice(0, 12);
      msgBody.innerHTML = rows.map(m => {
        const ts = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString().slice(0, 5) : '—';
        const cls = m.is_from_self ? ' class="self"' : '';
        const name = m.is_from_self ? '<b class="red-bright">karyasthan:</b>' : `<b>${escapeHtml(m.sender_name || '—')}:</b>`;
        const content = escapeHtml(m.content || `[${m.message_type || 'media'}]`);
        return `<tr${cls}><td class="id mono">${escapeHtml(ts)}</td><td>${name} ${content}</td></tr>`;
      }).join('') || '<tr><td colspan="2" class="empty">NO MESSAGES YET</td></tr>';
    }

    // Memories
    const memSlot = root.querySelector('[data-slot="gd-memories"]');
    if (memSlot) {
      memSlot.innerHTML = (g.memories || []).length
        ? `<table class="data"><tbody>${g.memories.map(m => `<tr><td class="mono mute">${escapeHtml(m.category)}</td><td>${escapeHtml(m.content)}</td><td class="num">${(m.importance ?? 0).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
        : '<span class="mute mono">—</span>';
    }
  } catch (err) { showError(root, err); }
}

// ── 03 PEOPLE ──
async function renderPeople() {
  const root = showShell('people');
  try {
    const people = await api('/api/people?limit=200');
    const recentCutoff = Date.now() / 1000 - 7 * 86400;
    const recent = people.filter(p => p.lastSeen && p.lastSeen > recentCutoff).length;
    setSlots(root, {
      'people-total': people.length,
      'people-recent': recent,
      'people-shown': people.length,
    });

    const traitSel = root.querySelector('#peopleTraitFilter');
    const traitsSeen = new Set();
    for (const p of people) for (const t of (p.traits || [])) traitsSeen.add(t);
    if (traitSel) {
      for (const t of [...traitsSeen].sort()) {
        const o = document.createElement('option'); o.value = t; o.textContent = t.toUpperCase();
        traitSel.appendChild(o);
      }
    }

    const tbody = root.querySelector('[data-slot="people-rows"]');
    const filterInput = root.querySelector('#peopleFilter');

    function renderRows() {
      const q = (filterInput?.value || '').toLowerCase();
      const traitF = (traitSel?.value || '').toLowerCase();
      tbody.innerHTML = '';
      let i = 1;
      for (const p of people) {
        const name = p.realName || p.pushName || p.jid;
        const text = `${name} ${(p.traits || []).join(' ')} ${(p.interests || []).join(' ')}`.toLowerCase();
        if (q && !text.includes(q)) continue;
        if (traitF && !(p.traits || []).map(t => t.toLowerCase()).includes(traitF)) continue;
        const traitChips = (p.traits || []).slice(0, 3).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || '<span class="mute mono">—</span>';
        const intChips = (p.interests || []).slice(0, 3).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || '<span class="mute mono">—</span>';
        const link = `#person/${encodeURIComponent(p.jid)}`;
        tbody.innerHTML += `
          <tr>
            <td class="id">${padz(i, 3)}</td>
            <td><b><a href="${link}">${escapeHtml(name)}</a></b></td>
            <td class="id">${escapeHtml(maskPhone(p.phone))}</td>
            <td>${traitChips}</td>
            <td>${intChips}</td>
            <td class="num">${(p.messageCount || 0).toLocaleString()}</td>
            <td class="mono mute">${fmtRelative(p.lastSeen)}</td>
          </tr>`;
        i++;
      }
      if (!tbody.children.length) tbody.innerHTML = `<tr><td colspan="7" class="empty">NO MATCHES</td></tr>`;
      setSlots(root, { 'people-shown': i - 1 });
    }
    filterInput?.addEventListener('input', renderRows);
    traitSel?.addEventListener('change', renderRows);
    renderRows();
  } catch (err) { showError(root, err); }
}

// ── 03.B PERSON DETAIL ──
async function renderPersonDetail(jid) {
  const root = showShell('personDetail');
  try {
    const p = await api(`/api/people/${encodeURIComponent(jid)}`);
    const name = p.real_name || p.push_name || p.jid;
    const initials = name.split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() || '?').join('');
    setSlots(root, {
      'pd-name': name,
      'pd-jid': p.jid,
      'pd-display-name': name,
      'pd-handle': `${maskPhone(p.phone)} · ${p.jid}`,
      'pd-seen': `first_seen ${fmtTime(p.first_seen)} · last_seen ${fmtRelative(p.last_seen)} ago`,
      'pd-initials': initials || '??',
      'pd-mem-count': p.memories?.length || 0,
    });

    const metaSlot = root.querySelector('[data-slot="pd-meta"]');
    if (metaSlot) {
      const traitsHtml = (p.traits || []).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || '<span class="mute">—</span>';
      const intsHtml = (p.interests || []).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || '<span class="mute">—</span>';
      const nicksHtml = (p.nicknames || []).map(n => `<span class="chip">${escapeHtml(n.nickname)}${n.use_count > 1 ? ' · ' + n.use_count : ''}</span>`).join('') || '<span class="mute">—</span>';
      metaSlot.innerHTML = [
        `<span class="mute">REAL_NAME</span><b>${escapeHtml(p.real_name || '—')}</b>`,
        `<span class="mute">SUMMARY</span><span>${escapeHtml(p.summary || '—')}</span>`,
        `<span class="mute">TRAITS</span><span>${traitsHtml}</span>`,
        `<span class="mute">INTERESTS</span><span>${intsHtml}</span>`,
        `<span class="mute">NICKS</span><span>${nicksHtml}</span>`,
        `<span class="mute">MESSAGES</span><b>${(p.message_count || 0).toLocaleString()}</b>`,
      ].join('');
    }

    // Edit form
    const form = root.querySelector('#pdEditForm');
    if (form) {
      form.real_name.value = p.real_name || '';
      form.summary.value = p.summary || '';
      form.traits.value = (p.traits || []).join(', ');
      form.interests.value = (p.interests || []).join(', ');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        if (form.real_name.value !== (p.real_name || '')) body.real_name = form.real_name.value;
        if (form.summary.value !== (p.summary || '')) body.summary = form.summary.value;
        const traits = form.traits.value.split(',').map(s => s.trim()).filter(Boolean);
        const interests = form.interests.value.split(',').map(s => s.trim()).filter(Boolean);
        if (JSON.stringify(traits) !== JSON.stringify(p.traits || [])) body.traits = traits;
        if (JSON.stringify(interests) !== JSON.stringify(p.interests || [])) body.interests = interests;
        if (!Object.keys(body).length) { flash('NO CHANGES', 'warn'); return; }
        try { await api(`/api/people/${encodeURIComponent(p.jid)}`, { method: 'PATCH', body });
          flash('SAVED'); renderPersonDetail(jid); } catch (err) { flash(err.message, 'bad'); }
      });
    }

    // Memories
    const memSlot = root.querySelector('[data-slot="pd-memories"]');
    if (memSlot) {
      memSlot.innerHTML = (p.memories || []).map(m => {
        const cls = m.category === 'temporary' ? 'chip warn' : (m.category === 'fact' ? 'chip' : 'chip');
        return `<tr><td class="mono mute"><span class="${cls}">${escapeHtml(m.category)}</span></td><td>${escapeHtml(m.content)}</td><td class="num">${(m.importance ?? 0).toFixed(2)}</td></tr>`;
      }).join('') || '<tr><td colspan="3" class="empty">NO MEMORIES</td></tr>';
    }

    // Recent
    const recSlot = root.querySelector('[data-slot="pd-recent"]');
    if (recSlot) {
      recSlot.innerHTML = (p.recentMessages || []).slice(0, 15).map(m => {
        const ts = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString().slice(0, 5) : '—';
        return `<tr><td class="id mono">${escapeHtml(ts)}</td><td>${escapeHtml(m.content || `[${m.message_type || 'media'}]`)}</td></tr>`;
      }).join('') || '<tr><td colspan="2" class="empty">NO MESSAGES</td></tr>';
    }
  } catch (err) { showError(root, err); }
}

// ── 04 MEMORIES ──
async function renderMemories() {
  const root = showShell('memories');
  try {
    const mems = await api('/api/memories?limit=300');
    const total = mems.length;
    const byCat = { fact: 0, temporary: 0, interest: 0 };
    let totalRecalls = 0, expiringSoon = 0, lowConf = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const m of mems) {
      byCat[m.category] = (byCat[m.category] || 0) + 1;
      totalRecalls += Number(m.recall_count || 0);
      if (m.expires_at && m.expires_at > now && m.expires_at < now + 86400) expiringSoon++;
      if ((m.importance ?? 1) < 0.30) lowConf++;
    }
    setSlots(root, {
      'mem-total': total,
      'mem-fact': byCat.fact || 0,
      'mem-temp': byCat.temporary || 0,
      'mem-interest': byCat.interest || 0,
      'mem-kpi-writes': total,
      'mem-kpi-recalls': totalRecalls.toLocaleString(),
      'mem-kpi-expiring': expiringSoon,
      'mem-kpi-lowconf': lowConf,
    });

    const tbody = root.querySelector('[data-slot="mem-rows"]');
    const filterInput = root.querySelector('#memFilter');
    const catSel = root.querySelector('#memCatFilter');
    function renderRows() {
      const q = (filterInput?.value || '').toLowerCase();
      const cat = catSel?.value || '';
      tbody.innerHTML = '';
      for (const m of mems) {
        if (cat && m.category !== cat) continue;
        if (q && !(m.content || '').toLowerCase().includes(q)) continue;
        const chipCls = m.category === 'temporary' ? 'chip warn' : 'chip';
        const expires = m.expires_at
          ? `<span class="amber mono">${fmtRelative(m.expires_at)}</span>`
          : '<span class="mute">—</span>';
        tbody.innerHTML += `
          <tr data-mem-id="${m.id}">
            <td class="id">#${m.id}</td>
            <td><span class="${chipCls}">${escapeHtml(m.category)}</span></td>
            <td>${escapeHtml(m.subject_name || '—')}</td>
            <td>${escapeHtml(m.group_name || '—')}</td>
            <td>${escapeHtml(m.content || '')}</td>
            <td class="num">${(m.importance ?? 0).toFixed(2)}</td>
            <td class="num">${m.recall_count || 0}</td>
            <td class="mono mute">${fmtRelative(m.created_at)}</td>
            <td>${expires}</td>
            <td><button class="danger mem-del" data-id="${m.id}" style="padding:3px 6px;font-size:9px">DEL</button></td>
          </tr>`;
      }
      if (!tbody.children.length) tbody.innerHTML = `<tr><td colspan="10" class="empty">NO MATCHES</td></tr>`;
      tbody.querySelectorAll('.mem-del').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Delete memory #${btn.dataset.id}?`)) return;
        try { await api(`/api/memories/${btn.dataset.id}`, { method: 'DELETE' });
          flash(`DELETED #${btn.dataset.id}`); renderMemories(); } catch (e) { flash(e.message, 'bad'); }
      }));
    }
    filterInput?.addEventListener('input', renderRows);
    catSel?.addEventListener('change', renderRows);
    renderRows();

    // Add memory toggle
    const addPanel = root.querySelector('#memAddPanel');
    root.querySelector('#memAddBtn')?.addEventListener('click', () => {
      addPanel.style.display = addPanel.style.display === 'none' ? '' : 'none';
    });
    root.querySelector('#memAddCancel')?.addEventListener('click', () => addPanel.style.display = 'none');
    root.querySelector('#memAddForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        category: fd.get('category'),
        subject_jid: fd.get('subject_jid') || null,
        group_jid: fd.get('group_jid') || null,
        content: fd.get('content'),
        importance: Number(fd.get('importance')) || 0.5,
        expires_in_days: fd.get('expires_in_days') ? Number(fd.get('expires_in_days')) : null,
      };
      try { await api('/api/memories', { method: 'POST', body });
        flash('MEMORY CREATED'); renderMemories(); } catch (err) { flash(err.message, 'bad'); }
    });
  } catch (err) { showError(root, err); }
}

// ── 05 DECISIONS ──
async function renderDecisions() {
  const root = showShell('decisions');
  try {
    const [rows, qres] = await Promise.all([
      api('/api/decisions?limit=200'),
      api('/api/quality').catch(() => ({ stats: {} })),
    ]);
    const fired = rows.filter(r => r.decided !== 'skip').length;
    const text = rows.filter(r => r.decided === 'text').length;
    const react = rows.filter(r => r.decided === 'reaction').length;
    const bs = rows.filter(r => (r.factors?.bs ?? 1) < 0.10).length;
    const rate = rows.length ? ((fired / rows.length) * 100).toFixed(1) + '%' : '—';
    setSlots(root, {
      'dec-samples': rows.length,
      'dec-fired': fired,
      'dec-rate': rate,
      'dec-kpi-eval': rows.length.toLocaleString(),
      'dec-kpi-eval-sub': `last ${rows.length} evaluations`,
      'dec-kpi-fired': fired,
      'dec-kpi-fired-sub': `TEXT ${text} · REACT ${react}`,
      'dec-kpi-gated': qres.stats?.gated_count ?? 0,
      'dec-kpi-bs': bs,
    });

    // Live feed
    const feed = root.querySelector('[data-slot="dec-feed"]');
    if (feed) {
      feed.innerHTML = rows.slice(0, 60).map(r => {
        const ts = r.createdAt ? new Date(r.createdAt * 1000).toLocaleTimeString() : '—';
        const score = r.score?.toFixed(2) ?? '—';
        const decided = r.decided?.toUpperCase() || '—';
        let lbl = '<b class="mute">SKIP</b>';
        if (r.decided === 'text') lbl = '<b class="red-bright">FIRE · TEXT</b>';
        else if (r.decided === 'reaction') lbl = '<b class="amber">FIRE · REACT</b>';
        else if (r.decided === 'bs') lbl = '<b class="mute">SKIP · BS</b>';
        const sender = r.message?.senderName || '—';
        const content = (r.message?.content || '[message gone]').slice(0, 100);
        return `<div class="logline" style="grid-template-columns:60px 1fr"><span class="lt">${escapeHtml(ts.slice(0, 8))}</span><span>${lbl} <span class="mono mute">[${score}]</span> · ${escapeHtml(sender)} · ${escapeHtml(content)}</span></div>`;
      }).join('') || '<div class="empty">NO DECISIONS YET</div>';
    }

    // Factor breakdown — first fired row
    const latest = rows.find(r => r.decided !== 'skip') || rows[0];
    if (latest) {
      const f = latest.factors || {};
      const setBar = (slot, num, value) => {
        const v = typeof value === 'number' ? value : null;
        const bar = root.querySelector(`[data-slot="dec-f-${slot}"]`);
        if (bar) bar.style.width = v != null ? `${Math.round(v * 100)}%` : '0%';
        const numEl = root.querySelector(`[data-slot="dec-n-${slot}"]`);
        if (numEl) numEl.textContent = v != null ? v.toFixed(2) : '—';
      };
      setBar('mention', null, f.mention);
      setBar('question', null, f.question);
      setBar('humor', null, f.humor);
      setBar('momentum', null, f.momentum);
      setBar('recency', null, f.recency);
      setBar('bs', null, f.bs);
      setBar('score', null, latest.score);
      setSlots(root, {
        'dec-factor-target': `${(latest.message?.senderName || '—').toUpperCase()} · ${latest.score?.toFixed(2) ?? '—'}`,
        'dec-decision': latest.decided?.toUpperCase() || '—',
      });
    }

    // Hourly bucket
    const hourly = new Array(24).fill(0);
    for (const r of rows) {
      if (!r.createdAt) continue;
      const h = new Date(r.createdAt * 1000).getHours();
      hourly[h] = (hourly[h] || 0) + 1;
    }
    renderSparkbar(root.querySelector('[data-slot="dec-sparkbar"]'), hourly, 5);
    setSlots(root, { 'dec-now': `${padz(new Date().getHours())}:${padz(new Date().getMinutes())}` });
  } catch (err) { showError(root, err); }
}

// ── 06 MESSAGES (search) ──
async function renderMessages() {
  const root = showShell('messages');
  const input = root.querySelector('#msgQuery');
  const runBtn = root.querySelector('#msgRun');
  const resultsBox = root.querySelector('[data-slot="msg-results"]');
  let timer;

  async function execute() {
    const q = input.value.trim();
    if (!q) { resultsBox.innerHTML = '<div class="empty">ENTER QUERY ABOVE</div>'; setSlots(root, { 'msg-hits': '—', 'msg-ms': '—', 'msg-summary': '—' }); return; }
    resultsBox.innerHTML = '<div class="loading">QUERYING</div>';
    const t0 = performance.now();
    try {
      const rows = await api(`/api/messages/search?q=${encodeURIComponent(q)}&limit=100`);
      const ms = (performance.now() - t0).toFixed(1);
      setSlots(root, {
        'msg-hits': rows.length,
        'msg-ms': ms,
        'msg-summary': `${rows.length} hits · ${ms}ms`,
      });
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+OR\s+|\s+AND\s+|\s+/i).filter(Boolean).map(s => s.replace(/^"|"$/g, '')).join('|')})`, 'gi');
      resultsBox.innerHTML = rows.length ? rows.map(m => {
        const ts = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString().slice(0, 5) : '—';
        const cls = m.is_from_self ? ' style="background:rgba(200,16,46,0.04)"' : '';
        const senderName = m.is_from_self ? '<b class="red-bright">karyasthan</b>' : `<b>${escapeHtml(m.sender_name || '—')}</b>`;
        const content = escapeHtml(m.content || `[${m.message_type || 'media'}]`).replace(re, '<mark>$1</mark>');
        return `<div class="logline" style="grid-template-columns:60px 110px 1fr"${cls}><span class="lt">${escapeHtml(ts)}</span><span class="mute">${escapeHtml((m.group_jid || '').slice(-12))}</span><span>${senderName}: ${content}</span></div>`;
      }).join('') : '<div class="empty">NO HITS</div>';

      // facets
      const byGroup = {}, bySender = {};
      for (const m of rows) {
        byGroup[m.group_jid || '—'] = (byGroup[m.group_jid || '—'] || 0) + 1;
        bySender[m.sender_name || '—'] = (bySender[m.sender_name || '—'] || 0) + 1;
      }
      const groupFacets = Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `<span class="chip">${escapeHtml(k.slice(-12))} · ${v}</span>`).join('') || '<span class="mute mono">—</span>';
      const senderFacets = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `<span class="chip">${escapeHtml(k)} · ${v}</span>`).join('') || '<span class="mute mono">—</span>';
      setSlotHtml(root, 'msg-facet-group', groupFacets);
      setSlotHtml(root, 'msg-facet-sender', senderFacets);

      const today = Date.now() / 1000;
      const counts = { '24h': 0, '7d': 0, '30d': 0 };
      for (const m of rows) {
        if (!m.timestamp) continue;
        const age = today - m.timestamp;
        if (age < 86400) counts['24h']++;
        if (age < 7 * 86400) counts['7d']++;
        if (age < 30 * 86400) counts['30d']++;
      }
      setSlotHtml(root, 'msg-facet-date',
        Object.entries(counts).map(([k, v]) => `<span class="chip">${k} · ${v}</span>`).join(''));
    } catch (err) {
      resultsBox.innerHTML = `<div class="empty" style="color:var(--red-bright)">ERROR · ${escapeHtml(err.message)}</div>`;
    }
  }

  input?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(execute, 300); });
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); execute(); } });
  runBtn?.addEventListener('click', execute);
}

// ── 07 BILLS ──
async function renderBills() {
  const root = showShell('bills');
  try {
    const rows = await api('/api/bills?limit=100');
    const open = rows.filter(b => ['ACTIVE', 'PARSED'].includes(b.state)).length;
    const completed = rows.filter(b => b.state === 'COMPLETED').length;
    const voided = rows.filter(b => ['VOID', 'EXPIRED'].includes(b.state)).length;
    const now = Math.floor(Date.now() / 1000);
    const stale = rows.filter(b => b.state !== 'COMPLETED' && (now - (b.updatedAt || b.createdAt || 0)) > 7 * 86400).length;
    const billRupees = (b) => Number(b.bill?.totalPaisa || 0) / 100;
    const totalBillSum = rows.reduce((acc, b) => acc + billRupees(b), 0);
    const outstanding = rows.filter(b => b.state !== 'COMPLETED').reduce((acc, b) => acc + billRupees(b), 0);
    const avgP = rows.length ? Math.round(rows.reduce((a, b) => a + (b.participantJids?.length || 0), 0) / rows.length) : 0;
    const fmtRup = (n) => `₹${Math.round(n).toLocaleString()}`;
    setSlots(root, {
      'bills-open': open,
      'bills-completed': completed,
      'bills-void': voided,
      'bills-count': `${rows.length} BILLS`,
      'bills-kpi-outstanding': totalBillSum ? fmtRup(outstanding) : '—',
      'bills-kpi-outstanding-sub': `${open} open bills`,
      'bills-kpi-total': totalBillSum ? fmtRup(totalBillSum) : '—',
      'bills-kpi-total-sub': `${rows.length} bills · ${completed} done`,
      'bills-kpi-avgp': rows.length ? Math.round(rows.reduce((a, b) => a + (b.people?.length || 0), 0) / rows.length) : '—',
      'bills-kpi-stale': stale,
    });

    const tbody = root.querySelector('[data-slot="bills-rows"]');
    const stateClass = (s) => s === 'COMPLETED' ? 'ok' : ['ACTIVE', 'PARSED'].includes(s) ? 'warn' : 'bad';
    const renderFocus = (b) => {
      const focus = root.querySelector('[data-slot="bills-focus"]');
      if (!focus) return;
      setSlots(root, { 'bills-focus-id': `#${b.id} · ${b.state}` });
      const items = b.bill?.items || [];
      const itemsHtml = items.map(it =>
        `<tr><td class="id">×${it.qty || 1}</td><td>${escapeHtml(it.name || '—')}</td><td class="num">₹${(Number(it.totalPricePaisa || 0) / 100).toFixed(2)}</td></tr>`
      ).join('');
      const subRows = [];
      if (b.bill?.subtotalPaisa) subRows.push(`<tr><td></td><td class="mute">SUBTOTAL</td><td class="num">₹${(b.bill.subtotalPaisa / 100).toFixed(2)}</td></tr>`);
      if (b.bill?.taxPaisa) subRows.push(`<tr><td></td><td class="mute">TAX</td><td class="num">₹${(b.bill.taxPaisa / 100).toFixed(2)}</td></tr>`);
      if (b.bill?.serviceChargePaisa) subRows.push(`<tr><td></td><td class="mute">SERVICE</td><td class="num">₹${(b.bill.serviceChargePaisa / 100).toFixed(2)}</td></tr>`);
      if (b.bill?.discountPaisa) subRows.push(`<tr><td></td><td class="mute">DISCOUNT</td><td class="num">−₹${(b.bill.discountPaisa / 100).toFixed(2)}</td></tr>`);
      if (b.bill?.totalPaisa) subRows.push(`<tr><td></td><td><b>TOTAL</b></td><td class="num"><b>₹${(b.bill.totalPaisa / 100).toFixed(2)}</b></td></tr>`);

      // Compute per-person split: for each assignment, divide item total by people.length
      const perPerson = {};
      for (const p of (b.people || [])) perPerson[p] = 0;
      for (const a of (b.assignments || [])) {
        const it = items[a.itemIndex];
        if (!it || !a.people?.length) continue;
        const share = Number(it.totalPricePaisa || 0) / a.people.length;
        for (const p of a.people) perPerson[p] = (perPerson[p] || 0) + share;
      }
      const splitRows = Object.entries(perPerson).sort((x, y) => y[1] - x[1]).map(([name, paisa]) =>
        `<tr><td>${escapeHtml(name)}</td><td class="num">₹${(paisa / 100).toFixed(2)}</td><td><span class="pill ${b.state === 'COMPLETED' ? 'ok' : 'warn'}">${b.state === 'COMPLETED' ? 'SETTLED' : 'PENDING'}</span></td></tr>`
      ).join('');

      focus.innerHTML = `
        <div class="cap mute" style="font-size:10px">${escapeHtml(b.restaurant || '—')} · ${escapeHtml(b.state)}</div>
        <table class="data" style="margin-top:6px">
          <tbody>
            ${itemsHtml || '<tr><td colspan="3" class="mute">NO LINE ITEMS</td></tr>'}
            ${subRows.join('')}
          </tbody>
        </table>
        <div class="divider" style="margin:14px 0"></div>
        <div class="cap mute" style="font-size:10px">SPLIT · ${(b.people || []).length}-WAY</div>
        <table class="data" style="margin-top:6px"><tbody>${splitRows || '<tr><td colspan="3" class="mute">NO ASSIGNMENTS</td></tr>'}</tbody></table>
      `;
    };

    tbody.innerHTML = rows.map(b => `
      <tr data-bill-id="${b.id}" style="cursor:pointer">
        <td class="id">#${b.id}</td>
        <td><b>${escapeHtml(b.restaurant || '—')}</b></td>
        <td><span class="pill ${stateClass(b.state)}">${escapeHtml(b.state)}</span></td>
        <td class="id">${escapeHtml((b.groupJid || '').slice(-12))}</td>
        <td class="num">${(b.people || []).length || (b.participantJids || []).length || 0}</td>
        <td class="mono mute">${fmtRelative(b.updatedAt || b.createdAt)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">NO BILLS</td></tr>';

    tbody.querySelectorAll('tr[data-bill-id]').forEach(tr => {
      tr.addEventListener('click', () => {
        const b = rows.find(x => String(x.id) === tr.dataset.billId);
        if (b) renderFocus(b);
      });
    });
    if (rows.length) renderFocus(rows[0]);
  } catch (err) { showError(root, err); }
}

// ── 08 LOGS ──
// Human-readable rendering of the structured Pino stream. Each line shows a
// category tag + the message sentence, an indented context line built from the
// structured fields (the decision "why" / the error detail), and a click-to-expand
// full dump. Nothing is hidden, but the default view is sentences + chips, never
// raw JSON.

const LOG_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
function logLevelName(level) { return LOG_LEVELS[level] || 'info'; }

const LOG_CATS = {
  reply: { label: 'REPLY', cls: 'reply' },
  react: { label: 'REACT', cls: 'react' },
  skip:  { label: 'SKIP',  cls: 'skip' },
  block: { label: 'BLOCK', cls: 'block' },
  issue: { label: 'ISSUE', cls: 'issue' },
  web:   { label: 'WEB',   cls: 'web' },
  audio: { label: 'AUDIO', cls: 'audio' },
  warn:  { label: 'WARN',  cls: 'warn' },
  info:  { label: 'INFO',  cls: 'info' },
  debug: { label: 'DEBUG', cls: 'debug' },
  trace: { label: 'TRACE', cls: 'trace' },
};
// Backend `evt` tag wins; otherwise derive a category from the level so every line
// gets a sensible tag (errors/fatals read as ISSUE).
function logCategory(p) {
  if (p.evt && LOG_CATS[p.evt]) return p.evt;
  const lvl = logLevelName(p.level);
  if (lvl === 'error' || lvl === 'fatal') return 'issue';
  return lvl; // warn | info | debug | trace
}
// Broad buckets for the category filter dropdown.
const CAT_BUCKET = {
  reply: 'decisions', react: 'decisions', skip: 'decisions', block: 'decisions',
  issue: 'issues', warn: 'issues',
};

// Group JID → name, fetched once per page load so context lines can say "#Family".
let _groupNames = null;
async function loadGroupNames() {
  if (_groupNames) return _groupNames;
  _groupNames = {};
  try {
    const groups = await api('/api/groups');
    for (const g of (groups || [])) if (g && g.jid) _groupNames[g.jid] = g.name || g.jid;
  } catch {}
  return _groupNames;
}
function groupLabel(jid) {
  if (!jid) return '';
  const name = _groupNames && _groupNames[jid];
  if (name) return name;
  const local = String(jid).split('@')[0];
  return local.length > 14 ? local.slice(0, 6) + '…' + local.slice(-4) : local;
}
function shortLogId(id) {
  const s = String(id || '');
  return s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s;
}

const FACTOR_KEYS = ['mention', 'question', 'command', 'humor', 'momentum', 'recency', 'bs', 'conversation'];
// Turn the decision-engine factor object into a readable formula, showing only the
// factors that actually moved the score (≠ 1), then the final score and the roll.
function formatFactors(f) {
  if (!f || typeof f !== 'object') return '';
  const parts = [];
  for (const k of FACTOR_KEYS) {
    const v = f[k];
    if (typeof v === 'number' && v !== 1) parts.push(`${k}×${+v.toFixed(2)}`);
  }
  let s = parts.join(' · ');
  if (typeof f.finalScore === 'number') s += `${s ? ' ' : ''}→ ${f.finalScore.toFixed(2)}`;
  if (typeof f.roll === 'number') s += ` (rolled ${f.roll.toFixed(2)})`;
  return s;
}

function errMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.msg || err.type || '';
}
function errStack(err) {
  return (err && typeof err === 'object' && typeof err.stack === 'string') ? err.stack : '';
}

// Fields the context line handles explicitly, plus pure Pino noise — excluded from
// the generic "key value" fallback below.
const CTX_HANDLED = new Set([
  'level', 'time', 'msg', 'pid', 'hostname', 'name', 'v', 'evt', 'factors', 'err',
  'group', 'groupJid', 'chatJid', 'sender', 'score', 'provider', 'model',
  'latencyMs', 'elapsedMs', 'reason', 'msgId',
]);
// Build the human context segments (the "why") from a parsed log object.
function logContextSegments(p) {
  const segs = [];
  const grp = p.group || p.groupJid || p.chatJid;
  if (grp) segs.push(`#${groupLabel(grp)}`);
  if (p.sender) segs.push(String(p.sender));
  if (typeof p.score === 'number') segs.push(`score ${p.score.toFixed(2)}`);
  const fac = formatFactors(p.factors);
  if (fac) segs.push(fac);
  if (p.reason != null && typeof p.reason !== 'object') segs.push(String(p.reason));
  if (p.provider) segs.push(p.provider + (p.model ? '/' + p.model : ''));
  if (typeof p.latencyMs === 'number') segs.push(`${p.latencyMs}ms`);
  if (typeof p.elapsedMs === 'number') segs.push(`${p.elapsedMs}ms`);
  const em = errMessage(p.err);
  if (em) segs.push(em);
  if (p.msgId) segs.push(`#${shortLogId(p.msgId)}`);
  for (const [k, v] of Object.entries(p)) {
    if (CTX_HANDLED.has(k)) continue;
    if (v == null || typeof v === 'object') continue;
    segs.push(`${k} ${v}`);
  }
  return segs;
}

// Compose the renderable entry: level + category for filtering, a plain searchable
// line for grep, and the two-row HTML card with an expandable full dump.
function buildLogEntry(p, raw) {
  const lvl = logLevelName(p.level);
  const cat = logCategory(p);
  const meta = LOG_CATS[cat] || LOG_CATS.info;
  const time = p.time ? new Date(p.time).toLocaleTimeString() : '';
  const msg = (p.msg || raw || '').toString();
  const segs = logContextSegments(p);
  const ctxText = segs.join('  ·  ');
  const stack = errStack(p.err);
  const dump = (stack ? stack + '\n\n' : '') + JSON.stringify(p, null, 2);

  const html =
    `<div class="logentry cat-${meta.cls}">` +
      `<div class="ll-main">` +
        `<span class="lt mono">${escapeHtml(time)}</span>` +
        `<span class="lcat">${meta.label}</span>` +
        `<span class="lm">${escapeHtml(msg)}</span>` +
        `<span class="lx-toggle mono" title="Show raw">▸</span>` +
      `</div>` +
      (ctxText ? `<div class="ll-ctx mono">${escapeHtml(ctxText)}</div>` : '') +
      `<pre class="ll-detail mono" hidden>${escapeHtml(dump)}</pre>` +
    `</div>`;

  return { lvl, cat, html, line: `${time} ${meta.label} ${lvl} ${msg} ${ctxText}` };
}

async function renderLogs() {
  const root = showShell('logs');
  const pane = root.querySelector('[data-slot="logs-pane"]');
  const pauseBtn = root.querySelector('#logsPause');
  const tailBtn = root.querySelector('#logsTail');
  const clearBtn = root.querySelector('#logsClear');
  const levelSel = root.querySelector('#logsLevel');
  const catSel = root.querySelector('#logsCat');
  const grepInp = root.querySelector('#logsGrep');
  const exportBtn = root.querySelector('#logsExport');

  let paused = false, tail = true;
  const buf = []; const MAX = 500;

  await loadGroupNames();

  function levelMatches(name) {
    const f = levelSel.value;
    if (!f) return true;
    const order = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    return (order[name] ?? 0) >= (order[f] ?? 0);
  }
  function catMatches(cat) {
    const f = catSel ? catSel.value : '';
    if (!f) return true;
    return CAT_BUCKET[cat] === f;
  }
  function passesFilters(e) {
    if (!levelMatches(e.lvl)) return false;
    if (!catMatches(e.cat)) return false;
    const grep = (grepInp.value || '').toLowerCase();
    if (grep && !e.line.toLowerCase().includes(grep)) return false;
    return true;
  }
  function appendLine(entry) {
    buf.push(entry); while (buf.length > MAX) buf.shift();
    if (paused) return;
    if (!passesFilters(entry)) return;
    pane.insertAdjacentHTML('beforeend', entry.html);
    while (pane.children.length > MAX) pane.removeChild(pane.firstChild);
    if (tail) pane.scrollTop = pane.scrollHeight;
    setSlots(root, { 'logs-buffer': `${buf.length} / ${MAX}` });
  }
  function rerenderAll() {
    pane.innerHTML = buf.filter(passesFilters).map(e => e.html).join('');
    if (tail) pane.scrollTop = pane.scrollHeight;
  }

  setSlots(root, { 'logs-stream': 'CONNECTING', 'logs-buffer': `0 / ${MAX}` });
  const es = trackStream(new EventSource('/api/stream/logs'));
  es.addEventListener('open', () => setSlots(root, { 'logs-stream': 'OPEN' }));
  es.addEventListener('log', (e) => {
    try {
      const entry = JSON.parse(e.data);
      appendLine(buildLogEntry(entry.parsed || {}, entry.raw));
    } catch {}
  });
  es.onerror = () => setSlots(root, { 'logs-stream': 'DISCONNECTED' });

  // Click a line to reveal its raw structured payload (delegated; lines churn).
  pane.addEventListener('click', (e) => {
    const main = e.target.closest('.ll-main');
    if (!main) return;
    const line = main.parentElement;
    const detail = line.querySelector('.ll-detail');
    if (!detail) return;
    const show = detail.hasAttribute('hidden');
    detail.toggleAttribute('hidden', !show);
    line.classList.toggle('expanded', show);
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
    pauseBtn.classList.toggle('danger', !paused);
    if (!paused) rerenderAll();
  });
  tailBtn.addEventListener('click', () => { tail = !tail; tailBtn.classList.toggle('primary', tail); if (tail) pane.scrollTop = pane.scrollHeight; });
  clearBtn.addEventListener('click', () => { buf.length = 0; pane.innerHTML = ''; setSlots(root, { 'logs-buffer': `0 / ${MAX}` }); });
  levelSel.addEventListener('change', rerenderAll);
  if (catSel) catSel.addEventListener('change', rerenderAll);
  grepInp.addEventListener('input', rerenderAll);
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([buf.map(e => e.line).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `karyasthan-logs-${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url);
  });
}

// ── 09 SETTINGS ──
async function renderSettings() {
  const root = showShell('settings');
  try {
    const cfg = await getConfig(true);
    const { mutableKeys, values } = cfg;
    // These six render in the bespoke LLM ROUTING panel below, not the generic table.
    const LLM_ROUTING_KEYS = ['llm.provider', 'llm.model', 'llm.fallbackProvider', 'llm.fallbackModel', 'qualityGate.provider', 'qualityGate.model'];
    setSlots(root, {
      'settings-keycount': `${mutableKeys.length} KEYS`,
      'settings-stamp': values.dashboard?.readOnly ? 'READ-ONLY' : 'READ/WRITE',
    });

    const getByPath = (obj, path) => path.split('.').reduce((o, p) => o?.[p], obj);

    const rowsBody = root.querySelector('[data-slot="settings-rows"]');
    rowsBody.innerHTML = mutableKeys.filter(key => !LLM_ROUTING_KEYS.includes(key)).map(key => {
      const v = getByPath(values, key);
      const isBool = typeof v === 'boolean';
      const isNum = typeof v === 'number';
      const inputHtml = isBool
        ? `<input type="checkbox" data-key="${escapeHtml(key)}" ${v ? 'checked' : ''} />`
        : `<input type="${isNum ? 'number' : 'text'}" data-key="${escapeHtml(key)}" value="${escapeHtml(String(v ?? ''))}" ${isNum && !Number.isInteger(v) ? 'step="0.01"' : ''} style="width:160px" />`;
      const hint = isBool ? (v ? 'on' : 'off') : (isNum ? 'numeric' : 'string');
      return `<tr><td class="mono mute">${escapeHtml(key)}</td><td>${inputHtml}</td><td class="mute">${escapeHtml(hint)}</td></tr>`;
    }).join('');

    const form = root.querySelector('#settingsForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {};
      for (const inp of form.querySelectorAll('[data-key]')) {
        const key = inp.dataset.key;
        const orig = getByPath(values, key);
        let val;
        if (typeof orig === 'boolean') val = inp.checked;
        else if (typeof orig === 'number') val = Number(inp.value);
        else val = inp.value;
        if (val !== orig) patch[key] = val;
      }
      if (!Object.keys(patch).length) { flash('NO CHANGES', 'warn'); return; }
      try {
        const result = await api('/api/config', { method: 'PATCH', body: patch });
        const aN = Object.keys(result.applied || {}).length;
        const rN = Object.keys(result.rejected || {}).length;
        flash(`APPLIED ${aN} · REJECTED ${rN}`, rN ? 'warn' : 'ok');
        cachedConfig = null;
      } catch (err) { flash(err.message, 'bad'); }
    });

    // ── LLM ROUTING panel ──
    const providers = cfg.providers || [];
    const modelCatalog = cfg.models || {};
    const ADD_SENTINEL = '__add_model__';
    const keyConfigured = {
      anthropic: values.llm?.apiKeyConfigured,
      openai: values.llm?.apiKeyConfigured,
      gemini: values.llm?.geminiKeyConfigured,
      glm: values.llm?.glmKeyConfigured,
      openrouter: values.llm?.openrouterKeyConfigured,
    };
    // ollama needs no key; local needs a base URL (LLM_BASE_URL); cloud needs its key.
    const usable = (p) => p === 'ollama' ? true : p === 'local' ? !!values.llm?.baseUrlConfigured : !!keyConfigured[p];
    const provOptions = (selected) => providers.map(p =>
      `<option value="${p}" ${p === selected ? 'selected' : ''}>${p}${usable(p) ? '' : (p === 'local' ? ' (no url)' : ' (no key)')}</option>`).join('');
    for (const sel of root.querySelectorAll('[data-llm-sel]')) {
      sel.innerHTML = provOptions(getByPath(values, sel.dataset.llmSel));
    }

    function fillModelSelect(sel, provider, current) {
      const list = [...(modelCatalog[provider] || [])];
      if (current && !list.includes(current)) list.unshift(current);
      const opts = list.map(m => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`);
      opts.push(`<option value="${ADD_SENTINEL}">+ add model…</option>`);
      sel.innerHTML = opts.join('');
      if (current && list.includes(current)) sel.value = current;
    }
    // Pair each provider <select> with its row's model <select>: repopulate the model
    // list when the provider changes, and handle the "+ add model…" sentinel (prompt →
    // POST /api/llm/models → persisted catalog).
    for (const provSel of root.querySelectorAll('[data-llm-sel]')) {
      const modelSel = provSel.closest('tr').querySelector('[data-llm-model]');
      fillModelSelect(modelSel, provSel.value, getByPath(values, modelSel.dataset.llmModel) ?? '');
      provSel.addEventListener('change', () => fillModelSelect(modelSel, provSel.value, ''));
      modelSel.addEventListener('change', async () => {
        if (modelSel.value !== ADD_SENTINEL) return;
        const name = (window.prompt(`New model id for "${provSel.value}":`) || '').trim();
        if (!name) { fillModelSelect(modelSel, provSel.value, ''); return; }
        try {
          const r = await api('/api/llm/models', { method: 'POST', body: { provider: provSel.value, model: name } });
          modelCatalog[provSel.value] = r.models;
          fillModelSelect(modelSel, provSel.value, name);
          flash(`MODEL ADDED · ${name}`, 'ok');
        } catch (err) { flash(err.message, 'bad'); fillModelSelect(modelSel, provSel.value, ''); }
      });
    }

    root.querySelector('#llmApplyRouting')?.addEventListener('click', async () => {
      const patch = {};
      for (const sel of root.querySelectorAll('[data-llm-sel]')) {
        const key = sel.dataset.llmSel;
        if (sel.value !== getByPath(values, key)) patch[key] = sel.value;
      }
      for (const inp of root.querySelectorAll('[data-llm-model]')) {
        const key = inp.dataset.llmModel;
        const val = inp.value.trim();
        if (val && val !== ADD_SENTINEL && val !== (getByPath(values, key) ?? '')) patch[key] = val;
      }
      // Guard provider/model drift: if a row's provider changed, it needs a real model
      // (an empty-catalog provider would otherwise leave the old provider's model behind).
      for (const provSel of root.querySelectorAll('[data-llm-sel]')) {
        if (provSel.value === getByPath(values, provSel.dataset.llmSel)) continue;
        const mv = (provSel.closest('tr').querySelector('[data-llm-model]')?.value || '').trim();
        if (!mv || mv === ADD_SENTINEL) {
          flash(`PICK/ADD A MODEL FOR ${provSel.value.toUpperCase()} BEFORE SWITCHING`, 'warn');
          return;
        }
      }
      if (!Object.keys(patch).length) { flash('NO ROUTING CHANGES', 'warn'); return; }
      try {
        const result = await api('/api/config', { method: 'PATCH', body: patch });
        const aN = Object.keys(result.applied || {}).length;
        const rej = Object.entries(result.rejected || {});
        flash(`ROUTING APPLIED ${aN}${rej.length ? ' · REJECTED ' + rej.map(([k, v]) => `${k.split('.').pop()}:${v}`).join(', ') : ''}`, rej.length ? 'warn' : 'ok');
        cachedConfig = null;
      } catch (err) { flash(err.message, 'bad'); }
    });

    const testOut = root.querySelector('[data-slot="llm-test-result"]');
    for (const btn of root.querySelectorAll('[data-llm-test]')) {
      btn.addEventListener('click', async () => {
        const [provKey, modelKey] = btn.dataset.llmTest.split('|');
        const provider = root.querySelector(`[data-llm-sel="${provKey}"]`)?.value;
        const rawModel = root.querySelector(`[data-llm-model="${modelKey}"]`)?.value || '';
        const model = rawModel === ADD_SENTINEL ? '' : rawModel.trim();
        if (testOut) testOut.innerHTML = `<span class="mute">TESTING ${escapeHtml(provider)}…</span>`;
        try {
          const r = await api('/api/llm/test', { method: 'POST', body: { provider, model } });
          if (!testOut) return;
          if (r.ok) {
            testOut.innerHTML = `<span style="color:#8bc06b">✓ ${escapeHtml(provider)} OK · ${r.latencyMs}ms · "${escapeHtml(r.reply || '')}"</span>`;
          } else {
            const e = r.error;
            const reason = typeof e === 'string' ? e : (e?.body || e?.message || (e?.status ? 'HTTP ' + e.status : 'no response'));
            testOut.innerHTML = `<span style="color:var(--red-bright)">✗ ${escapeHtml(provider)} FAILED · ${r.latencyMs}ms · ${escapeHtml(reason)}</span>`;
          }
        } catch (err) { if (testOut) testOut.innerHTML = `<span style="color:var(--red-bright)">TEST ERR · ${escapeHtml(err.message)}</span>`; }
      });
    }

    const keyRows = root.querySelector('[data-slot="llm-keys-rows"]');
    if (keyRows) {
      const keyFields = [
        ['apiKey', 'LLM_API_KEY (anthropic/openai)', 'apiKeyConfigured'],
        ['geminiApiKey', 'GEMINI_API_KEY', 'geminiKeyConfigured'],
        ['glmApiKey', 'GLM_API_KEY', 'glmKeyConfigured'],
        ['openrouterApiKey', 'OPENROUTER_API_KEY', 'openrouterKeyConfigured'],
      ];
      keyRows.innerHTML = keyFields.map(([field, label, flag]) => {
        const set = values.llm?.[flag];
        return `<tr><td class="mono mute" style="font-size:10px">${label}<br><span style="color:${set ? '#8bc06b' : 'var(--ink-3)'}">${set ? '✓ SET' : '· NOT SET'}</span></td><td><input type="password" data-llm-key="${field}" placeholder="${set ? '•••• replace' : 'paste key'}" autocomplete="off" style="width:180px" /></td><td><button type="button" data-llm-savekey="${field}">SAVE</button></td></tr>`;
      }).join('');
      for (const btn of keyRows.querySelectorAll('[data-llm-savekey]')) {
        btn.addEventListener('click', async () => {
          const field = btn.dataset.llmSavekey;
          const inp = keyRows.querySelector(`[data-llm-key="${field}"]`);
          if (!inp.value.trim()) { flash('ENTER A KEY', 'warn'); return; }
          const persist = root.querySelector('#llmKeyPersist')?.checked === true;
          try {
            const r = await api('/api/llm/keys', { method: 'POST', body: { field, value: inp.value, persist } });
            inp.value = '';
            flash(`KEY SAVED · ${field}${r.persisted ? ' · PERSISTED .ENV' : ''}`, 'ok');
            cachedConfig = null;
          } catch (err) { flash(err.message, 'bad'); }
        });
      }
    }

    // Static block
    const staticPre = root.querySelector('[data-slot="settings-static"]');
    if (staticPre) {
      const lines = [
        ['SLEEP_START_HOUR', values.sleepStartHour],
        ['SLEEP_END_HOUR', values.sleepEndHour],
        ['TIMEZONE', values.timezone],
        ['DASHBOARD_HOST', values.dashboard?.host],
        ['DASHBOARD_PORT', values.dashboard?.port],
        ['DASHBOARD_READONLY', values.dashboard?.readOnly],
      ];
      staticPre.innerHTML = lines.map(([k, v]) => `${k.padEnd(22)}= <b>${escapeHtml(v ?? '—')}</b>`).join('\n');
    }

    // Diff & persist
    const diffSlot = root.querySelector('[data-slot="settings-diff"]');
    async function refreshDiff() {
      diffSlot.innerHTML = '<div class="loading">LOADING DIFF</div>';
      try {
        const { diffs } = await api('/api/config/diff');
        if (!diffs.length) { diffSlot.innerHTML = '<div class="mute mono" style="font-size:11px">▸ LIVE CONFIG MATCHES .ENV — NOTHING TO PERSIST</div>'; return; }
        diffSlot.innerHTML = `
          <div class="cap mute" style="font-size:10px">PENDING DIFF · ${diffs.length} KEY(S)</div>
          <table class="data" style="margin-top:6px"><thead><tr><th>KEY</th><th>.ENV</th><th>LIVE</th></tr></thead>
          <tbody>${diffs.map(d => `<tr><td class="mono">${escapeHtml(d.envKey)}</td><td class="mute">${escapeHtml(d.envValue ?? '—')}</td><td><b>${escapeHtml(d.liveValue)}</b></td></tr>`).join('')}</tbody></table>`;
      } catch (err) {
        diffSlot.innerHTML = `<div class="empty" style="color:var(--red-bright)">DIFF ERR · ${escapeHtml(err.message)}</div>`;
      }
    }
    refreshDiff();

    root.querySelector('#settingsPersist')?.addEventListener('click', async () => {
      if (!confirm('Write live config to .env (with backup)?')) return;
      try { const r = await api('/api/config/persist', { method: 'POST', body: { confirm: true } });
        flash(`PERSISTED ${r.applied?.length || 0} KEY(S)`); refreshDiff(); }
      catch (err) { flash(err.message, 'bad'); }
    });

    // Pairing
    const pairBtn = root.querySelector('#pairBtn');
    const pairBanner = root.querySelector('#pairCodeBanner');
    const pairLog = root.querySelector('#pairLog');
    pairBtn?.addEventListener('click', async () => {
      const phone = (root.querySelector('#pairPhone').value || '').replace(/\D/g, '');
      if (phone.length < 8) { flash('ENTER PHONE WITH COUNTRY CODE', 'warn'); return; }
      try {
        const { id } = await api('/api/pair/start', { method: 'POST', body: { phone } });
        pairLog.style.display = 'block'; pairLog.innerHTML = '';
        pairBanner.style.display = 'none';
        flash(`PAIRING ${id} STARTED`);
        const es = trackStream(new EventSource(`/api/pair/${id}/stream`));
        es.addEventListener('line', (e) => {
          const { text } = JSON.parse(e.data);
          pairLog.innerHTML += `<div>${escapeHtml(text)}</div>`;
          pairLog.scrollTop = pairLog.scrollHeight;
        });
        es.addEventListener('code', (e) => {
          const { code } = JSON.parse(e.data);
          pairBanner.textContent = `PAIRING CODE · ${code}`;
          pairBanner.style.display = 'block';
        });
        es.addEventListener('paired', () => {
          pairBanner.textContent = 'PAIRED ✓ — RESTART BOT (pm2 restart karyasthan)';
          pairBanner.style.display = 'block';
          es.close();
        });
        es.addEventListener('exit', () => es.close());
      } catch (err) { flash(err.message, 'bad'); }
    });

    // Maintenance
    root.querySelector('#mntMemBtn')?.addEventListener('click', async () => {
      try { const r = await api('/api/maintenance/memory', { method: 'POST', body: {} });
        flash(`EXPIRED ${r.expired} · DECAYED ${r.decayed}`); } catch (err) { flash(err.message, 'bad'); }
    });
    root.querySelector('#mntBillBtn')?.addEventListener('click', async () => {
      try { const r = await api('/api/maintenance/bills', { method: 'POST', body: {} });
        flash(`EXPIRED ${r.expired} BILLS`); } catch (err) { flash(err.message, 'bad'); }
    });
  } catch (err) { showError(root, err); }
}

// ── 10 IDENTITY ──
async function renderIdentity() {
  const root = showShell('identity');
  try {
    const { text } = await api('/api/identity');
    const editor = root.querySelector('#idEditor');
    editor.value = text;
    const updateMeta = () => {
      const v = editor.value;
      const lines = v.split('\n').length;
      const cursor = v.slice(0, editor.selectionStart);
      const line = cursor.split('\n').length;
      const col = cursor.length - cursor.lastIndexOf('\n');
      setSlots(root, {
        'id-bytes': v.length.toLocaleString(),
        'id-lines': lines,
        'id-cursor': `L ${line} · COL ${col}`,
        'id-statusline': `▸ UTF-8 · LF · MARKDOWN · ${lines} LINES · ${v.length} BYTES`,
      });
    };
    updateMeta();
    editor.addEventListener('input', updateMeta);
    editor.addEventListener('keyup', updateMeta);
    editor.addEventListener('click', updateMeta);

    root.querySelector('#idDiscard')?.addEventListener('click', () => {
      if (!confirm('Discard local changes?')) return;
      editor.value = text; updateMeta();
    });
    root.querySelector('#idSave')?.addEventListener('click', async () => {
      try { await api('/api/identity', { method: 'PUT', body: { text: editor.value } });
        flash('IDENTITY SAVED · HOT-RELOADED'); } catch (err) { flash(err.message, 'bad'); }
    });
  } catch (err) { showError(root, err); }
}

// ── 11 SKILLS ──
async function renderSkills() {
  const root = showShell('skills');
  try {
    const skills = await api('/api/skills');
    const enabled = skills.filter(s => s.enabled).length;
    setSlots(root, {
      'skills-loaded': skills.length,
      'skills-enabled': enabled,
      'skills-disabled': skills.length - enabled,
    });
    const tbody = root.querySelector('[data-slot="skills-rows"]');
    tbody.innerHTML = skills.map((s, i) => `
      <tr>
        <td class="id">${padz(i + 1, 2)}</td>
        <td><b>${escapeHtml(s.name)}</b></td>
        <td><span class="pill ${s.enabled ? 'ok' : 'bad'}">${s.enabled ? 'ENABLED' : 'DISABLED'}</span></td>
        <td>${escapeHtml(s.description || '')}</td>
        <td><button class="${s.enabled ? 'danger' : 'primary'} skill-toggle" data-name="${escapeHtml(s.name)}" data-enabled="${s.enabled}">${s.enabled ? 'DISABLE' : 'ENABLE'}</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">NO SKILLS LOADED</td></tr>';
    tbody.querySelectorAll('.skill-toggle').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const wasEnabled = btn.dataset.enabled === 'true';
      try { await api(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: { enabled: !wasEnabled } });
        flash(`${name.toUpperCase()} ${!wasEnabled ? 'ENABLED' : 'DISABLED'}`); renderSkills(); } catch (err) { flash(err.message, 'bad'); }
    }));
  } catch (err) { showError(root, err); }
}

// ── 12 AUDIT ──
async function renderAudit() {
  const root = showShell('audit');
  try {
    const rows = await api('/api/audit?limit=200');
    const actors = new Set(rows.map(r => r.actor).filter(Boolean));
    setSlots(root, {
      'audit-total': rows.length,
      'audit-actors': actors.size,
      'audit-shown': `${rows.length} ENTRIES`,
    });

    const actionSel = root.querySelector('#auditActionFilter');
    const actionsSeen = new Set(rows.map(r => r.action).filter(Boolean));
    if (actionSel) {
      for (const a of [...actionsSeen].sort()) {
        const o = document.createElement('option'); o.value = a; o.textContent = a;
        actionSel.appendChild(o);
      }
    }

    const tbody = root.querySelector('[data-slot="audit-rows"]');
    const filterInput = root.querySelector('#auditFilter');

    function renderRows() {
      const q = (filterInput?.value || '').toLowerCase();
      const action = actionSel?.value || '';
      tbody.innerHTML = '';
      let i = rows.length;
      for (const r of rows) {
        if (action && r.action !== action) continue;
        const text = `${r.action || ''} ${r.actor || ''} ${r.target || ''} ${JSON.stringify(r.payload || {})}`.toLowerCase();
        if (q && !text.includes(q)) { i--; continue; }
        const payloadStr = r.payload ? JSON.stringify(r.payload).slice(0, 80) : '';
        tbody.innerHTML += `
          <tr>
            <td class="id">#${r.id}</td>
            <td class="mono mute">${fmtRelative(r.ts)}</td>
            <td><b>${escapeHtml(r.actor || '—')}</b></td>
            <td><span class="chip">${escapeHtml(r.action || '—')}</span></td>
            <td class="mono" style="font-size:11px">${escapeHtml(r.target || '—')}</td>
            <td class="mono mute" style="font-size:10px">${escapeHtml(payloadStr)}</td>
          </tr>`;
        i--;
      }
      if (!tbody.children.length) tbody.innerHTML = `<tr><td colspan="6" class="empty">NO MATCHES</td></tr>`;
    }
    filterInput?.addEventListener('input', renderRows);
    actionSel?.addEventListener('change', renderRows);
    renderRows();

    root.querySelector('#auditExport')?.addEventListener('click', () => {
      const blob = new Blob([rows.map(r => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `audit-${Date.now()}.jsonl`; a.click();
      URL.revokeObjectURL(url);
    });
  } catch (err) { showError(root, err); }
}

// ────── router ──────────────────────────────────────────────────────────

const routes = [
  { match: /^#?$|^#status$/, page: 'status', handler: () => renderStatus() },
  { match: /^#groups$/, page: 'groups', handler: () => renderGroups() },
  { match: /^#group\/(.+)$/, page: 'groups', handler: (m) => renderGroupDetail(decodeURIComponent(m[1])) },
  { match: /^#people$/, page: 'people', handler: () => renderPeople() },
  { match: /^#person\/(.+)$/, page: 'people', handler: (m) => renderPersonDetail(decodeURIComponent(m[1])) },
  { match: /^#memories$/, page: 'memories', handler: () => renderMemories() },
  { match: /^#decisions$/, page: 'decisions', handler: () => renderDecisions() },
  { match: /^#messages$/, page: 'messages', handler: () => renderMessages() },
  { match: /^#bills$/, page: 'bills', handler: () => renderBills() },
  { match: /^#logs$/, page: 'logs', handler: () => renderLogs() },
  { match: /^#settings$/, page: 'settings', handler: () => renderSettings() },
  { match: /^#identity$/, page: 'identity', handler: () => renderIdentity() },
  { match: /^#skills$/, page: 'skills', handler: () => renderSkills() },
  { match: /^#audit$/, page: 'audit', handler: () => renderAudit() },
];

function setActiveNav(pageId) {
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === pageId);
  });
}

function route() {
  closeAllStreams();
  document.getElementById('app')?.classList.remove('menu-open');
  const hash = window.location.hash || '#status';
  for (const r of routes) {
    const m = hash.match(r.match);
    if (m) {
      setActiveNav(r.page);
      r.handler(m);
      window.scrollTo(0, 0);
      return;
    }
  }
  const root = document.getElementById('content');
  root.innerHTML = `<div class="empty">UNKNOWN ROUTE · ${escapeHtml(hash)}</div>`;
}

// ────── boot ────────────────────────────────────────────────────────────

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  // Hamburger
  document.getElementById('menuToggle')?.addEventListener('click', () => {
    document.getElementById('app')?.classList.toggle('menu-open');
  });

  // Clock + frame counter
  tickClock();
  setInterval(tickClock, 1000);

  // Topbar refresh
  refreshTopbar();
  setInterval(refreshTopbar, 30000);

  route();
});
