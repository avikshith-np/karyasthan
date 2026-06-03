// Static HTML chrome shells per page. JS populates [data-slot] regions and
// rebuilds tbody rows after fetching the page's data. Decorative bits
// (sequence numbers, panel titles, factor labels) stay hardcoded.

window.PAGES = {

status: `
<div class="page-header">
  <div>
    <div class="crumb">// 01 · SECTOR-7 · OBSERVATION DECK</div>
    <h1><span class="seq">[01]</span><span class="glitch" data-text="STATUS">STATUS</span></h1>
  </div>
  <div class="meta">
    <span><span class="dot-live"></span> SOCKET <b data-slot="sock-state">—</b></span>
    <span>FRAME <b class="mono" id="frameTwo">000000</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>CONNECTION</span><span class="id mono">01.A</span></div>
    <div class="val" data-slot="status-conn">—</div>
    <div class="sub" data-slot="status-conn-sub">—</div>
  </div>
  <div class="kpi"><div class="lab"><span>UPTIME</span><span class="id mono">01.B</span></div>
    <div class="val mono" data-slot="status-uptime">—</div>
    <div class="sub" data-slot="status-uptime-sub">since process boot</div>
  </div>
  <div class="kpi"><div class="lab"><span>MEMORY · RSS</span><span class="id mono">01.C</span></div>
    <div class="val mono" data-slot="status-memory">—</div>
    <div class="sub" data-slot="status-memory-sub">—</div>
  </div>
  <div class="kpi" data-slot="status-warmup-card"><div class="lab"><span>WARMUP</span><span class="id mono">01.D</span></div>
    <div class="val mono" data-slot="status-warmup">—</div>
    <div class="sub" data-slot="status-warmup-sub">—</div>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>// VOLUME · 30D</span>
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
    <div class="panel-head"><span>// COOLDOWNS · <b data-slot="status-cooldown-count">0</b> ACTIVE</span><span class="pill warn" data-slot="status-cooldown-pill" style="display:none">THROTTLE</span></div>
    <div class="row-list" data-slot="status-cooldowns">
      <div><span class="idx mono">--</span><div><div class="mute">No active cooldowns.</div></div><div></div></div>
    </div>
    <div class="panel-head" style="border-top:1px solid var(--line-2);border-bottom:none"><span>// SLEEP WINDOW</span><span class="mono" data-slot="status-sleep">—</span></div>
  </div>
</div>

<div class="col-3" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>// LLM · ROUTING</span><span class="mono mute" data-slot="status-llm-source">PRIMARY</span></div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-family:var(--font-mono);font-size:11px">
        <span class="mute">PROVIDER</span><b data-slot="status-llm-provider">—</b>
        <span class="mute">MODEL</span><b data-slot="status-llm-model">—</b>
        <span class="mute">TEMP</span><b data-slot="status-llm-temp">—</b>
        <span class="mute">MAX_TOK</span><b data-slot="status-llm-maxtok">—</b>
        <span class="mute">FALLBACK</span><b class="mute" data-slot="status-llm-fallback">—</b>
        <span class="mute">RATE</span><b data-slot="status-llm-rate">—</b>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// FLAGS</span><span class="mono mute">RUNTIME</span></div>
    <div class="panel-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-family:var(--font-mono);font-size:11px" data-slot="status-flags">
      <span class="mute">DRY_RUN</span><b>—</b>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// DAILY · LAST 7</span><span class="mono mute">SENT</span></div>
    <div class="panel-body">
      <div class="sparkbar" style="height:60px;align-items:flex-end" data-slot="status-sparkbar"></div>
      <table class="data" style="margin-top:10px"><tbody data-slot="status-daily"></tbody></table>
    </div>
  </div>
</div>
`,

groups: `
<div class="page-header">
  <div>
    <div class="crumb">// 02 · GROUPS · SUBJECTS UNDER OBSERVATION</div>
    <h1><span class="seq">[02]</span>Groups</h1>
  </div>
  <div class="meta">
    <span>TOTAL <b data-slot="groups-total">—</b></span>
    <span>ACTIVE <b data-slot="groups-active">—</b></span>
    <span>MUTED <b class="red" data-slot="groups-muted">—</b></span>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="// FILTER · NAME / JID / VIBE" id="groupsFilter" />
  <select id="groupsVibeFilter"><option value="">ALL VIBES</option></select>
</div>

<div class="panel">
  <div class="panel-head"><span>// REGISTRY</span><span class="mono mute" data-slot="groups-sort">SORTED · LAST_ACTIVE DESC</span></div>
  <table class="data">
    <thead><tr><th>#</th><th>NAME</th><th>JID</th><th>VIBE</th><th>MEMBERS</th><th>MSG·30D</th><th>LAST</th><th>STATE</th></tr></thead>
    <tbody data-slot="groups-rows"><tr><td colspan="8" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`,

groupDetail: `
<div class="page-header">
  <div>
    <div class="crumb">// 02.B · GROUP DOSSIER</div>
    <h1><span class="seq">[02]</span><span data-slot="gd-name">—</span></h1>
  </div>
  <div class="meta">
    <span><a href="#groups" class="mute">← REGISTRY</a></span>
    <span data-slot="gd-state">—</span>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>// FOCUS</span><span class="mono mute" data-slot="gd-jid">—</span></div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size:11px" data-slot="gd-meta"></div>

      <div style="margin-top:14px"><b class="cap mute">SLANG</b></div>
      <div style="margin-top:6px" data-slot="gd-slang"><span class="mute mono">—</span></div>

      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size:10px">CONTROLS</div>
      <div style="margin-top:8px;display:grid;gap:8px" data-slot="gd-controls"></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// LAST MESSAGES</span><span class="dot-live"></span></div>
    <table class="data"><tbody data-slot="gd-messages"></tbody></table>

    <div class="panel-head" style="border-top:1px solid var(--line-2)"><span>// MEMBERS</span><span class="mono mute" data-slot="gd-member-count">0</span></div>
    <table class="data"><tbody data-slot="gd-members"></tbody></table>

    <div class="panel-head" style="border-top:1px solid var(--line-2)"><span>// GROUP MEMORIES</span></div>
    <div class="panel-body" data-slot="gd-memories"><span class="mute mono">—</span></div>
  </div>
</div>
`,

people: `
<div class="page-header">
  <div>
    <div class="crumb">// 03 · PEOPLE · INDIVIDUAL DOSSIERS</div>
    <h1><span class="seq">[03]</span>People</h1>
  </div>
  <div class="meta">
    <span>TRACKED <b data-slot="people-total">—</b></span>
    <span>RECENT <b data-slot="people-recent">—</b></span>
    <span>SHOWING <b data-slot="people-shown">—</b></span>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="// FILTER · NAME / TRAIT" id="peopleFilter" />
  <select id="peopleTraitFilter"><option value="">ALL TRAITS</option></select>
</div>

<div class="panel">
  <div class="panel-head"><span>// REGISTRY</span><span class="mono mute" data-slot="people-sort">SORTED · LAST_SEEN DESC</span></div>
  <table class="data">
    <thead><tr><th>#</th><th>NAME</th><th>HANDLE</th><th>TRAITS</th><th>INTERESTS</th><th>MSG</th><th>LAST</th></tr></thead>
    <tbody data-slot="people-rows"><tr><td colspan="7" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`,

personDetail: `
<div class="page-header">
  <div>
    <div class="crumb">// 03.B · INDIVIDUAL DOSSIER</div>
    <h1><span class="seq">[03]</span><span data-slot="pd-name">—</span></h1>
  </div>
  <div class="meta">
    <span><a href="#people" class="mute">← REGISTRY</a></span>
    <span class="stamp">EYES ONLY</span>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>// DOSSIER</span><span class="mono mute" data-slot="pd-jid">—</span></div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:64px;height:64px;background:var(--bg-3);border:1px solid var(--line-3);position:relative" class="crosshair">
          <div style="position:absolute;inset:8px;background:var(--bg-2);font-family:var(--font-mono);font-weight:700;font-size:22px;color:var(--ink-1);display:grid;place-items:center" data-slot="pd-initials">??</div>
        </div>
        <div>
          <div style="font-size:18px;font-weight:600" data-slot="pd-display-name">—</div>
          <div class="mono mute" style="font-size:11px" data-slot="pd-handle">—</div>
          <div class="mono mute" style="font-size:11px" data-slot="pd-seen">—</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-family:var(--font-mono);font-size:11px" data-slot="pd-meta"></div>

      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size:10px">EDIT</div>
      <form id="pdEditForm" style="display:grid;gap:6px;margin-top:8px">
        <input type="text" name="real_name" placeholder="real_name" />
        <input type="text" name="summary" placeholder="summary" />
        <input type="text" name="traits" placeholder="traits (comma separated)" />
        <input type="text" name="interests" placeholder="interests (comma separated)" />
        <button class="primary" type="submit">SAVE</button>
      </form>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// MEMORIES</span><span class="mono mute" data-slot="pd-mem-count">0</span></div>
    <table class="data"><tbody data-slot="pd-memories"></tbody></table>

    <div class="panel-head" style="border-top:1px solid var(--line-2)"><span>// RECENT MESSAGES</span></div>
    <table class="data"><tbody data-slot="pd-recent"></tbody></table>
  </div>
</div>
`,

memories: `
<div class="page-header">
  <div>
    <div class="crumb">// 04 · MEMORIES · ENCODED FACTS</div>
    <h1><span class="seq">[04]</span>Memories</h1>
  </div>
  <div class="meta">
    <span>TOTAL <b data-slot="mem-total">—</b></span>
    <span>FACT <b data-slot="mem-fact">—</b></span>
    <span>TEMP <b class="amber" data-slot="mem-temp">—</b></span>
    <span>INTEREST <b data-slot="mem-interest">—</b></span>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:12px">
  <input type="search" placeholder="// FILTER · CONTENT" id="memFilter" />
  <select id="memCatFilter"><option value="">ALL CATEGORIES</option><option value="fact">fact</option><option value="temporary">temporary</option><option value="interest">interest</option></select>
  <button class="primary" id="memAddBtn">+ ADD MEMORY</button>
</div>

<div class="panel" id="memAddPanel" style="margin-bottom:12px;display:none">
  <div class="panel-head"><span>// NEW MEMORY</span></div>
  <div class="panel-body">
    <form id="memAddForm" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
      <select name="category" required><option value="fact">fact</option><option value="temporary">temporary</option><option value="interest">interest</option></select>
      <input type="text" name="subject_jid" placeholder="subject_jid (optional)" />
      <input type="text" name="group_jid" placeholder="group_jid (optional)" />
      <input type="text" name="content" placeholder="content" required style="grid-column:span 2" />
      <input type="number" name="importance" step="0.05" min="0" max="1" value="0.5" placeholder="importance" />
      <input type="number" name="expires_in_days" placeholder="expires_in_days (opt)" />
      <button type="button" class="" id="memAddCancel">CANCEL</button>
      <button class="primary" type="submit" style="grid-column:span 2">CREATE</button>
    </form>
  </div>
</div>

<div class="kpi-grid" style="margin-bottom:14px">
  <div class="kpi"><div class="lab"><span>WRITES · TOTAL</span><span class="id mono">M.A</span></div>
    <div class="val mono" data-slot="mem-kpi-writes">—</div><div class="sub">all categories</div></div>
  <div class="kpi"><div class="lab"><span>RECALLS · TOTAL</span><span class="id mono">M.B</span></div>
    <div class="val mono" data-slot="mem-kpi-recalls">—</div><div class="sub">summed recall_count</div></div>
  <div class="kpi"><div class="lab"><span>EXPIRING · 24H</span><span class="id mono">M.C</span></div>
    <div class="val mono amber" data-slot="mem-kpi-expiring">—</div><div class="sub">temp · auto-purge</div></div>
  <div class="kpi alert"><div class="lab"><span>LOW-CONFIDENCE</span><span class="id mono">M.D</span></div>
    <div class="val mono" data-slot="mem-kpi-lowconf">—</div><div class="sub">imp &lt; 0.30 · review</div></div>
</div>

<div class="panel">
  <div class="panel-head"><span>// MEMORY LEDGER</span><span class="mono mute">SORT · CREATED DESC</span></div>
  <table class="data">
    <thead><tr><th>ID</th><th>CAT</th><th>SUBJECT</th><th>GROUP</th><th>CONTENT</th><th>IMP</th><th>RECALL</th><th>CREATED</th><th>EXPIRES</th><th></th></tr></thead>
    <tbody data-slot="mem-rows"><tr><td colspan="10" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`,

decisions: `
<div class="page-header">
  <div>
    <div class="crumb">// 05 · DECISIONS · 6-FACTOR PROBABILITY</div>
    <h1><span class="seq">[05]</span><span class="glitch" data-text="Decisions">Decisions</span></h1>
  </div>
  <div class="meta">
    <span>SAMPLES <b data-slot="dec-samples">—</b></span>
    <span>FIRED <b class="red" data-slot="dec-fired">—</b></span>
    <span>RATE <b data-slot="dec-rate">—</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>EVALUATED · WINDOW</span><span class="id mono">D.A</span></div><div class="val mono" data-slot="dec-kpi-eval">—</div><div class="sub" data-slot="dec-kpi-eval-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>FIRED</span><span class="id mono">D.B</span></div><div class="val mono" data-slot="dec-kpi-fired">—</div><div class="sub" data-slot="dec-kpi-fired-sub">TEXT — · REACT —</div></div>
  <div class="kpi"><div class="lab"><span>QUALITY · GATED</span><span class="id mono">D.C</span></div><div class="val mono amber" data-slot="dec-kpi-gated">—</div><div class="sub">post-LLM rejected</div></div>
  <div class="kpi alert"><div class="lab"><span>BS DETECTED</span><span class="id mono">D.D</span></div><div class="val mono red-bright" data-slot="dec-kpi-bs">—</div><div class="sub">factor.bs &lt; 0.10</div></div>
</div>

<div class="col-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>// LIVE FEED · LAST 200 EVALS</span><span class="dot-live"></span></div>
    <div style="max-height:540px;overflow-y:auto" data-slot="dec-feed"></div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// FACTOR BREAKDOWN · LATEST FIRE</span><span class="mono mute" data-slot="dec-factor-target">—</span></div>
    <div class="panel-body">
      <div class="factor-bar"><span class="label">MENTION</span><span class="track"><span class="f" data-slot="dec-f-mention" style="width:0%"></span></span><span class="num" data-slot="dec-n-mention">—</span></div>
      <div class="factor-bar"><span class="label">QUESTION</span><span class="track"><span class="f" data-slot="dec-f-question" style="width:0%"></span></span><span class="num" data-slot="dec-n-question">—</span></div>
      <div class="factor-bar"><span class="label">HUMOR</span><span class="track"><span class="f" data-slot="dec-f-humor" style="width:0%;background:var(--ink-3)"></span></span><span class="num" data-slot="dec-n-humor">—</span></div>
      <div class="factor-bar"><span class="label">MOMENTUM</span><span class="track"><span class="f" data-slot="dec-f-momentum" style="width:0%"></span></span><span class="num" data-slot="dec-n-momentum">—</span></div>
      <div class="factor-bar"><span class="label">RECENCY</span><span class="track"><span class="f" data-slot="dec-f-recency" style="width:0%"></span></span><span class="num" data-slot="dec-n-recency">—</span></div>
      <div class="factor-bar"><span class="label">BS-DETECT</span><span class="track"><span class="f" data-slot="dec-f-bs" style="width:0%;background:var(--green)"></span></span><span class="num" data-slot="dec-n-bs">—</span></div>
      <div class="divider" style="margin:10px 0"></div>
      <div class="factor-bar" style="font-weight:700"><span class="label">SCORE</span><span class="track"><span class="f" data-slot="dec-f-score" style="width:0%"></span></span><span class="num red-bright" data-slot="dec-n-score">—</span></div>
      <div class="mute mono" style="font-size:10px;margin-top:8px">DECISION <b class="red-bright" data-slot="dec-decision">—</b></div>

      <div class="divider-thick" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size:10px;margin-bottom:6px">// HOURLY EVAL RATE · 24H</div>
      <div class="sparkbar" style="height:50px" data-slot="dec-sparkbar"></div>
      <div class="mute mono" style="font-size:10px;display:flex;justify-content:space-between;margin-top:4px"><span>00:00</span><span data-slot="dec-now">—</span><span>23:59</span></div>
    </div>
  </div>
</div>
`,

messages: `
<div class="page-header">
  <div>
    <div class="crumb">// 06 · MESSAGE SEARCH · FTS5</div>
    <h1><span class="seq">[06]</span>Search</h1>
  </div>
  <div class="meta">
    <span>HITS <b data-slot="msg-hits">—</b></span>
    <span>QUERY-MS <b data-slot="msg-ms">—</b></span>
  </div>
</div>

<div class="panel" style="margin-bottom:14px">
  <div class="panel-body" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center">
    <input type="search" id="msgQuery" placeholder='// QUERY · FTS5 · double-quote phrases · use AND/OR/NOT' />
    <button class="primary" id="msgRun">EXECUTE</button>
  </div>
  <div style="padding:8px 12px;border-top:1px solid var(--line-2);font-family:var(--font-mono);font-size:10px;color:var(--ink-3);display:flex;gap:14px">
    <span><span class="kbd">/</span> focus</span>
    <span><span class="kbd">↵</span> run</span>
    <span data-slot="msg-summary" class="red-bright">—</span>
  </div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>// HITS</span><span class="mono mute">SORT · TIMESTAMP DESC</span></div>
    <div style="max-height:540px;overflow-y:auto" data-slot="msg-results"><div class="empty">ENTER QUERY ABOVE</div></div>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// FACETS</span><span class="mono mute">REFINE</span></div>
    <div class="panel-body">
      <div class="cap mute" style="font-size:10px">BY GROUP</div>
      <div style="margin-top:6px" data-slot="msg-facet-group"><span class="mute mono">—</span></div>
      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size:10px">BY SENDER</div>
      <div style="margin-top:6px" data-slot="msg-facet-sender"><span class="mute mono">—</span></div>
      <div class="divider" style="margin:14px 0"></div>
      <div class="cap mute" style="font-size:10px">BY DATE</div>
      <div style="margin-top:6px" data-slot="msg-facet-date"><span class="mute mono">—</span></div>
    </div>
  </div>
</div>
`,

bills: `
<div class="page-header">
  <div>
    <div class="crumb">// 07 · BILLS · GROUP EXPENSE LEDGER</div>
    <h1><span class="seq">[07]</span>Bills</h1>
  </div>
  <div class="meta">
    <span>OPEN <b class="amber" data-slot="bills-open">—</b></span>
    <span>COMPLETED <b data-slot="bills-completed">—</b></span>
    <span>VOID <b class="red" data-slot="bills-void">—</b></span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="lab"><span>OUTSTANDING</span><span class="id mono">B.A</span></div><div class="val mono" data-slot="bills-kpi-outstanding">—</div><div class="sub" data-slot="bills-kpi-outstanding-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>TOTAL · ALL</span><span class="id mono">B.B</span></div><div class="val mono" data-slot="bills-kpi-total">—</div><div class="sub" data-slot="bills-kpi-total-sub">—</div></div>
  <div class="kpi"><div class="lab"><span>AVG PARTICIPANTS</span><span class="id mono">B.C</span></div><div class="val mono" data-slot="bills-kpi-avgp">—</div><div class="sub">per bill</div></div>
  <div class="kpi alert"><div class="lab"><span>STALE &gt; 7D</span><span class="id mono">B.D</span></div><div class="val mono red-bright" data-slot="bills-kpi-stale">—</div><div class="sub">non-completed · auto-expire</div></div>
</div>

<div class="col-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><span>// LEDGER</span><span class="mono mute" data-slot="bills-count">—</span></div>
    <table class="data">
      <thead><tr><th>#</th><th>RESTAURANT</th><th>STATE</th><th>GROUP</th><th>P</th><th>UPDATED</th></tr></thead>
      <tbody data-slot="bills-rows"><tr><td colspan="6" class="loading">LOADING</td></tr></tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-head"><span>// FOCUS</span><span class="mono mute" data-slot="bills-focus-id">—</span></div>
    <div class="panel-body" data-slot="bills-focus"><span class="mute mono">SELECT A BILL</span></div>
  </div>
</div>
`,

logs: `
<div class="page-header">
  <div>
    <div class="crumb">// 08 · LIVE STREAM · SSE · /api/stream/logs</div>
    <h1><span class="seq">[08]</span><span class="glitch" data-text="Live Logs">Live Logs</span></h1>
  </div>
  <div class="meta">
    <span><span class="dot-live" data-slot="logs-stream-dot"></span>STREAM <b data-slot="logs-stream">CONNECTING</b></span>
    <span>BUFFER <b data-slot="logs-buffer">0 / 500</b></span>
  </div>
</div>

<div style="display:grid;grid-template-columns:auto auto auto auto auto 1fr auto;gap:6px;margin-bottom:10px;align-items:center">
  <button class="danger" id="logsPause">⏸ PAUSE</button>
  <button id="logsTail">↓ TAIL</button>
  <button id="logsClear">⌫ CLEAR</button>
  <select id="logsLevel">
    <option value="">ALL LEVELS</option>
    <option value="error">error+</option>
    <option value="warn">warn+</option>
    <option value="info">info+</option>
  </select>
  <input type="search" id="logsGrep" placeholder="// GREP" />
  <span></span>
  <button class="primary" id="logsExport">↧ EXPORT</button>
</div>

<div class="panel sweep" style="height:540px;overflow-y:auto;font-size:11px" data-slot="logs-pane"></div>
`,

settings: `
<div class="page-header">
  <div>
    <div class="crumb">// 09 · CONTROL · LIVE PARAMETERS</div>
    <h1><span class="seq">[09]</span>Settings</h1>
  </div>
  <div class="meta"><span class="stamp" data-slot="settings-stamp">READ-ONLY</span></div>
</div>

<div style="background:rgba(200,16,46,0.08);border:1px solid var(--red-deep);padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
  <span class="dot-live"></span>
  <div class="mono" style="font-size:11px"><b class="red-bright">CAUTION</b> · CHANGES ARE IN-MEMORY ONLY. PM2 RESTART REVERTS UNLESS PERSISTED TO .ENV.</div>
</div>

<div class="col-2">
  <div class="panel">
    <div class="panel-head"><span>// MUTABLE · APPLY LIVE</span><span class="mono mute" data-slot="settings-keycount">— KEYS</span></div>
    <div class="panel-body">
      <form id="settingsForm">
        <table class="data">
          <tbody data-slot="settings-rows"><tr><td colspan="3" class="loading">LOADING</td></tr></tbody>
        </table>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="primary" type="submit">APPLY (IN-MEMORY)</button>
          <button type="reset">RESET</button>
          <button class="danger" type="button" id="settingsPersist">PERSIST → .ENV</button>
        </div>
      </form>
      <div data-slot="settings-diff" style="margin-top:14px"></div>
    </div>
  </div>

  <div>
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head"><span>// STATIC · REQUIRES .ENV + RESTART</span><span class="mono mute">VALUES</span></div>
      <div class="panel-body">
        <pre class="mono" style="font-size:11px;color:var(--ink-1);margin:0;line-height:1.7" data-slot="settings-static">—</pre>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head"><span>// RE-PAIR WHATSAPP</span><span class="mono mute">DISCONNECTED ONLY</span></div>
      <div class="panel-body">
        <div class="mute mono" style="font-size:11px">UNLINK FROM PHONE FIRST · THEN ENTER NUMBER WITH COUNTRY CODE</div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <input type="text" id="pairPhone" placeholder="+91 98 XXXX XXXX" style="flex:1" />
          <button class="primary" id="pairBtn">START PAIRING</button>
        </div>
        <div class="mono" id="pairCodeBanner" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--green);text-align:center;font-size:18px;font-weight:700;color:#8bc06b">—</div>
        <div class="mono" id="pairLog" style="display:none;margin-top:10px;padding:10px;border:1px dashed var(--line-3);font-size:10px;color:var(--ink-3);max-height:160px;overflow-y:auto"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span>// MAINTENANCE</span><span class="mono mute">RUN ON DEMAND</span></div>
      <div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="mntMemBtn">▸ MEMORY CLEANUP</button>
        <button id="mntBillBtn">▸ EXPIRE STALE BILLS</button>
      </div>
    </div>
  </div>
</div>
`,

identity: `
<div class="page-header">
  <div>
    <div class="crumb">// 10 · IDENTITY · CHARACTER DEFINITION</div>
    <h1><span class="seq">[10]</span>Identity</h1>
  </div>
  <div class="meta">
    <span>BYTES <b class="mono" data-slot="id-bytes">—</b></span>
    <span>LINES <b class="mono" data-slot="id-lines">—</b></span>
    <span class="stamp">HOT-RELOAD</span>
  </div>
</div>

<div style="background:rgba(198,146,20,0.08);border:1px solid var(--amber);padding:10px 14px;margin-bottom:14px;font-family:var(--font-mono);font-size:11px">
  <b class="amber">⚠ HOT-RELOAD</b> · saving rewrites <code style="color:var(--ink-1)">src/personality/identity.md</code> and the next LLM call uses the new prompt. <b>The bot's personality is overwritten the moment you save.</b>
</div>

<div class="panel">
  <div class="panel-head"><span>// IDENTITY.MD · MARKDOWN</span><span class="mono"><span class="caret-mono" data-slot="id-cursor">L 1 · COL 1</span></span></div>
  <textarea id="idEditor" spellcheck="false" style="display:block;width:100%;min-height:520px;padding:14px;background:var(--bg-1);border:none;border-top:1px solid var(--line-2);color:var(--ink-1);font-family:var(--font-mono);font-size:12px;line-height:1.65;resize:vertical">LOADING</textarea>
  <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-top:1px solid var(--line-2);background:var(--bg-2)">
    <div class="mono mute" style="font-size:10px" data-slot="id-statusline">▸ UTF-8 · LF · MARKDOWN</div>
    <div style="display:flex;gap:6px"><button id="idDiscard">↩ DISCARD</button><button class="primary" id="idSave">SAVE + HOT-RELOAD</button></div>
  </div>
</div>
`,

skills: `
<div class="page-header">
  <div>
    <div class="crumb">// 11 · SKILLS · LOADED MODULES</div>
    <h1><span class="seq">[11]</span>Skills</h1>
  </div>
  <div class="meta">
    <span>LOADED <b data-slot="skills-loaded">—</b></span>
    <span>ENABLED <b class="green" data-slot="skills-enabled">—</b></span>
    <span>DISABLED <b class="mute" data-slot="skills-disabled">—</b></span>
  </div>
</div>

<div class="panel">
  <table class="data">
    <thead><tr><th>#</th><th>NAME</th><th>STATE</th><th>DESCRIPTION</th><th></th></tr></thead>
    <tbody data-slot="skills-rows"><tr><td colspan="5" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`,

audit: `
<div class="page-header">
  <div>
    <div class="crumb">// 12 · AUDIT TRAIL · IMMUTABLE LEDGER</div>
    <h1><span class="seq">[12]</span><span class="glitch" data-text="Audit">Audit</span></h1>
  </div>
  <div class="meta">
    <span>WRITES <b data-slot="audit-total">—</b></span>
    <span>OPERATORS <b data-slot="audit-actors">—</b></span>
    <span class="stamp">EVERY ACTION RECORDED</span>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:12px">
  <input type="search" id="auditFilter" placeholder="// FILTER · ACTION / ACTOR / TARGET" />
  <select id="auditActionFilter"><option value="">ALL ACTIONS</option></select>
  <button id="auditExport">↧ EXPORT JSONL</button>
</div>

<div class="panel">
  <div class="panel-head"><span>// LEDGER</span><span class="mono mute" data-slot="audit-shown">—</span></div>
  <table class="data">
    <thead><tr><th>#</th><th>WHEN</th><th>ACTOR</th><th>ACTION</th><th>TARGET</th><th>PAYLOAD</th></tr></thead>
    <tbody data-slot="audit-rows"><tr><td colspan="6" class="loading">LOADING</td></tr></tbody>
  </table>
</div>
`,

};
