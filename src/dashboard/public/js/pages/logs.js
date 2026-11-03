// 08 LIVE LOGS — the structured Pino stream (topic `logs`), rendered as sentences:
// a category tag + the message, an indented context line built from the
// structured fields (the decision "why" / the error detail), and a click-to-expand
// full dump. Nothing is hidden, but the default view is never raw JSON.
//
// Every log entry carries a monotonic id. The page subscribes with
// { resume: false } so it gets the tail on mount, then drops any entry whose id
// it has already shown — a reconnect (Last-Event-ID / ?since=) never duplicates.
import { api, isAbort } from '../core/api.js';
import { html, raw, render, renderToString, setSlots, $ } from '../core/dom.js';
import { fmtClock } from '../core/fmt.js';

const SHELL = raw(`
<div class="page-header">
  <div>
    <div class="crumb">CONTROL · LIVE LOGS · WHAT THE BOT IS DOING</div>
    <h1>Live Logs</h1>
  </div>
  <div class="meta">
    <span><span class="dot-live"></span>STREAM <b data-slot="logs-stream">CONNECTING</b></span>
    <span>BUFFER <b data-slot="logs-buffer">0 / 500</b></span>
  </div>
</div>

<div class="toolbar" style="display:grid;grid-template-columns:auto auto auto auto auto auto 1fr auto;gap:6px;margin-bottom:10px;align-items:center">
  <button class="danger" id="logsPause">⏸ PAUSE</button>
  <button id="logsTail">↓ FOLLOW</button>
  <button id="logsClear">⌫ CLEAR</button>
  <select id="logsLevel" aria-label="Minimum level">
    <option value="">ALL LEVELS</option>
    <option value="error">error+</option>
    <option value="warn">warn+</option>
    <option value="info">info+</option>
    <option value="debug">debug+</option>
  </select>
  <select id="logsCat" aria-label="Event category">
    <option value="">ALL EVENTS</option>
    <option value="decisions">DECISIONS</option>
    <option value="issues">ISSUES</option>
    <option value="web">WEB</option>
    <option value="audio">AUDIO</option>
  </select>
  <input type="search" id="logsGrep" aria-label="Filter log lines" placeholder="FILTER LINES" />
  <span></span>
  <button class="primary" id="logsExport">↧ EXPORT</button>
</div>

<div class="panel sweep" style="height:540px;overflow-y:auto;font-size: var(--t-meta)" data-slot="logs-pane" role="log" aria-live="off"></div>
`);

const MAX = 500;
const LOG_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
const levelName = (level) => LOG_LEVELS[level] || 'info';

const LOG_CATS = {
  reply: 'REPLY', react: 'REACT', skip: 'SKIP', block: 'BLOCK', issue: 'ISSUE', web: 'WEB',
  audio: 'AUDIO', warn: 'WARN', info: 'INFO', debug: 'DEBUG', trace: 'TRACE',
};
// The backend modules behind the WEB / AUDIO tags: web search + browse log with
// mod:'web', transcription + voice notes + cloned voices with mod:'audio'.
const LOG_MODS = new Set(['web', 'audio']);
// Backend `evt` tag wins; then a web/audio module tags its info/debug lines
// (its warnings and errors stay WARN / ISSUE); otherwise the level decides
// (errors/fatals read as ISSUE).
export function logCategory(p) {
  if (p.evt && LOG_CATS[p.evt]) return p.evt;
  const lvl = levelName(p.level);
  if (lvl === 'error' || lvl === 'fatal') return 'issue';
  if (lvl !== 'warn' && LOG_MODS.has(p.mod)) return p.mod;
  return lvl;
}
// Broad buckets for the category filter. WEB / AUDIO match the module, at any level.
const CAT_BUCKET = { reply: 'decisions', react: 'decisions', skip: 'decisions', block: 'decisions', issue: 'issues', warn: 'issues' };
export function inBucket(entry, bucket) {
  return LOG_MODS.has(bucket) ? entry.mod === bucket : CAT_BUCKET[entry.cat] === bucket;
}

const FACTOR_KEYS = ['mention', 'question', 'command', 'humor', 'momentum', 'recency', 'bs', 'conversation'];
// The factors that moved the score (≠ 1), then the final score and the roll.
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
const errMessage = (err) => (!err ? '' : typeof err === 'string' ? err : err.message || err.msg || err.type || '');
const errStack = (err) => (err && typeof err === 'object' && typeof err.stack === 'string' ? err.stack : '');
const shortId = (id) => { const s = String(id || ''); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };

// Fields the context line handles explicitly, plus Pino noise.
const CTX_HANDLED = new Set([
  'level', 'time', 'msg', 'pid', 'hostname', 'name', 'v', 'evt', 'mod', 'factors', 'err',
  'group', 'groupJid', 'chatJid', 'sender', 'score', 'provider', 'model',
  'latencyMs', 'elapsedMs', 'reason', 'msgId',
]);

function makeBuilder(groupNames) {
  const groupLabel = (jid) => {
    if (!jid) return '';
    if (groupNames[jid]) return groupNames[jid];
    const local = String(jid).split('@')[0];
    return local.length > 14 ? `${local.slice(0, 6)}…${local.slice(-4)}` : local;
  };
  function contextSegments(p) {
    const segs = [];
    const grp = p.group || p.groupJid || p.chatJid;
    if (grp) segs.push(`#${groupLabel(grp)}`);
    if (p.sender) segs.push(String(p.sender));
    if (typeof p.score === 'number') segs.push(`score ${p.score.toFixed(2)}`);
    const fac = formatFactors(p.factors);
    if (fac) segs.push(fac);
    if (p.reason != null && typeof p.reason !== 'object') segs.push(String(p.reason));
    if (p.provider) segs.push(p.provider + (p.model ? `/${p.model}` : ''));
    if (typeof p.latencyMs === 'number') segs.push(`${p.latencyMs}ms`);
    if (typeof p.elapsedMs === 'number') segs.push(`${p.elapsedMs}ms`);
    const em = errMessage(p.err);
    if (em) segs.push(em);
    if (p.msgId) segs.push(`#${shortId(p.msgId)}`);
    for (const [k, v] of Object.entries(p)) {
      if (CTX_HANDLED.has(k) || v == null || typeof v === 'object') continue;
      segs.push(`${k} ${v}`);
    }
    return segs;
  }
  // { lvl, cat, mod, html, line } — level + category for filtering, a plain line for
  // grep/export, and the escaped two-row card.
  return function build(p, rawLine) {
    const lvl = levelName(p.level);
    const cat = logCategory(p);
    const time = p.time ? fmtClock(p.time) : '';
    const msg = String(p.msg || rawLine || '');
    const ctxText = contextSegments(p).join('  ·  ');
    const stack = errStack(p.err);
    const dump = (stack ? `${stack}\n\n` : '') + JSON.stringify(p, null, 2);
    const markup = renderToString(html`<div class="logentry cat-${cat}">
      <div class="ll-main" role="button" tabindex="0" aria-expanded="false"><span class="lt mono">${time}</span><span class="lcat">${LOG_CATS[cat] || 'INFO'}</span><span class="lm">${msg}</span><span class="lx-toggle mono" title="Show raw" aria-hidden="true">▸</span></div>
      ${ctxText ? html`<div class="ll-ctx mono">${ctxText}</div>` : null}
      <pre class="ll-detail mono" hidden>${dump}</pre>
    </div>`);
    return { lvl, cat, mod: LOG_MODS.has(p.mod) ? p.mod : null, html: markup, line: `${time} ${LOG_CATS[cat] || 'INFO'} ${lvl} ${msg} ${ctxText}` };
  };
}

export async function mount(ctx) {
  const root = ctx.root;
  render(root, SHELL);
  const pane = $(root, '[data-slot="logs-pane"]');
  const pauseBtn = $(root, '#logsPause');
  const tailBtn = $(root, '#logsTail');
  const clearBtn = $(root, '#logsClear');
  const levelSel = $(root, '#logsLevel');
  const catSel = $(root, '#logsCat');
  const grepInp = $(root, '#logsGrep');
  const exportBtn = $(root, '#logsExport');
  tailBtn?.classList.add('primary');

  let paused = false;
  let tail = true;
  let lastId = -Infinity;
  const buf = [];

  const groupNames = {};
  try {
    const groups = await api('/api/groups', { signal: ctx.signal });
    for (const g of groups || []) if (g?.jid) groupNames[g.jid] = g.name || g.jid;
  } catch (err) {
    if (isAbort(err)) return;
  }
  if (!ctx.alive()) return;
  const build = makeBuilder(groupNames);

  const passes = (e) => {
    const f = levelSel.value;
    if (f && (LEVEL_ORDER[e.lvl] ?? 0) < (LEVEL_ORDER[f] ?? 0)) return false;
    if (catSel.value && !inBucket(e, catSel.value)) return false;
    const grep = (grepInp.value || '').toLowerCase();
    return !grep || e.line.toLowerCase().includes(grep);
  };
  const setBuffer = () => setSlots(root, { 'logs-buffer': `${buf.length} / ${MAX}` });
  const rerenderAll = () => {
    pane.innerHTML = buf.filter(passes).map((e) => e.html).join('');
    if (tail) pane.scrollTop = pane.scrollHeight;
  };

  function append(entry) {
    buf.push(entry);
    while (buf.length > MAX) buf.shift();
    setBuffer();
    if (paused || !passes(entry)) return;
    pane.insertAdjacentHTML('beforeend', entry.html); // entry.html is built by html`` (escaped)
    while (pane.children.length > MAX) pane.removeChild(pane.firstChild);
    if (tail) pane.scrollTop = pane.scrollHeight;
  }

  setSlots(root, { 'logs-stream': 'CONNECTING' });
  setBuffer();
  ctx.onStreamState((s) => {
    setSlots(root, { 'logs-stream': s === 'open' ? 'OPEN' : s === 'error' ? 'RECONNECTING' : s === 'idle' ? 'IDLE' : 'CONNECTING' });
  });
  ctx.on('logs', (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = Number(entry.id);
    if (Number.isFinite(id)) {
      if (id <= lastId) return; // already shown (replayed backlog after a reconnect)
      lastId = id;
    }
    append(build(entry.parsed || {}, entry.raw));
  }, { resume: false });

  // Click (or Enter) on a line reveals its raw payload. Delegated: lines churn.
  const toggle = (e) => {
    const main = e.target.closest?.('.ll-main');
    if (!main) return;
    if (e.type === 'keydown') { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); }
    const line = main.parentElement;
    const detail = line.querySelector('.ll-detail');
    if (!detail) return;
    const show = detail.hasAttribute('hidden');
    detail.toggleAttribute('hidden', !show);
    line.classList.toggle('expanded', show);
    main.setAttribute('aria-expanded', show ? 'true' : 'false');
  };
  ctx.listen(pane, 'click', toggle);
  ctx.listen(pane, 'keydown', toggle);

  ctx.listen(pauseBtn, 'click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
    pauseBtn.classList.toggle('danger', !paused);
    if (!paused) rerenderAll();
  });
  ctx.listen(tailBtn, 'click', () => {
    tail = !tail;
    tailBtn.classList.toggle('primary', tail);
    if (tail) pane.scrollTop = pane.scrollHeight;
  });
  ctx.listen(clearBtn, 'click', () => { buf.length = 0; pane.replaceChildren(); setBuffer(); });
  ctx.listen(levelSel, 'change', rerenderAll);
  ctx.listen(catSel, 'change', rerenderAll);
  ctx.listen(grepInp, 'input', rerenderAll);
  ctx.listen(exportBtn, 'click', () => {
    const blob = new Blob([buf.map((e) => e.line).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `karyasthan-logs-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
}
