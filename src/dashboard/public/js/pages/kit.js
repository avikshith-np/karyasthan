// #kit: every shared piece with example data, ordinary and worst case. Not in the nav (reach
// it by address). The phone checks run over it, and a new view can build on these before its
// real page exists. Reads and writes nothing.
import { $, html, render } from '../core/dom.js';
import { flash } from '../components/flash.js';
import { openSheet } from '../components/sheet.js';
import {
  alertList, dreamCard, fold, formRow, initFolds, kpi, liveLine, segments, stanceRow, stream, toldRow, toldRows, twoCol,
} from '../components/views.js';

const LONG = 'Averyverylongnamewithnospacesatallthatnevertheendsbecauseanamecanbethislongandstillhastofit';

const section = (title, body) => html`<section class="kit-section"><h2>${title}</h2>${body}</section>`;

const page = (seg) => html`
<div class="page-header"><div>
  <div class="crumb">CONTROL · KIT · THE SHARED PIECES</div>
  <h1>Kit</h1>
</div></div>

${section('Stat tiles', html`<div class="kpi-grid">
  ${kpi({ label: 'Messages', id: 'K.A', value: '1,204', sub: 'last 24 h' })}
  ${kpi({ label: 'Queued', id: 'K.B', value: '0', sub: 'nothing waiting' })}
  ${kpi({ label: 'Spend', id: 'K.C', value: '$3.12', sub: 'month to date' })}
  ${kpi({ label: 'Failures', id: 'K.D', value: '2', sub: 'needs a look', alert: true })}
</div>`)}

${section('Chips and buttons', html`<div class="kit-row">
  <span class="chip">plain</span><span class="chip ok">ok</span><span class="chip warn">warn</span><span class="chip bad">bad</span>
  <span class="pill">pill</span><span class="pill ok">ok</span><span class="pill warn">warn</span><span class="pill bad">bad</span><span class="pill live">live</span>
</div>
<div class="kit-row" style="margin-top:8px">
  <button type="button">Plain</button><button type="button" class="primary" id="kitFlash">Primary</button><button type="button" class="danger">Danger</button><button type="button" disabled>Disabled</button>
  <button type="button" id="kitSheet">Open a sheet</button>
</div>`)}

${section('Segments', html`<div id="kitSeg">${segments([['a', 'Today'], ['b', 'This week', 3], ['c', 'All of it'], ['d', 'Long section name']], seg)}</div>`)}

${section('A wide table (cards on a phone)', html`<div class="panel"><div class="panel-head"><span>ROWS</span><span>6 COLUMNS</span></div>
  <table class="data"><thead><tr><th>#</th><th>Name</th><th>Kind</th><th>Note</th><th class="num">Score</th><th></th></tr></thead><tbody>
    <tr><td class="id">#14</td><td><a href="#kit">Avery</a></td><td><span class="chip">group</span></td><td>Keeps saying they will host, and never does.</td><td class="num">0.70</td><td><button type="button">OPEN</button></td></tr>
    <tr><td class="id">#13</td><td><a href="#kit">${LONG}</a></td><td><span class="chip warn">dm</span></td><td>${LONG}</td><td class="num">0.31</td><td></td></tr>
    <tr><td colspan="6" class="mute">A row spanning the table is a message, not a value.</td></tr>
  </tbody></table></div>`)}

${section('A short table (stays a table)', html`<div class="panel"><table class="data"><thead><tr><th>From</th><th>To</th><th>What</th></tr></thead><tbody>
  <tr><td class="mono">15:00</td><td class="mono">15:45</td><td>meeting</td></tr>
  <tr><td class="mono">15:45</td><td class="mono">16:30</td><td>work</td></tr>
</tbody></table></div>`)}

${section('A form row', html`<div class="panel"><div class="panel-body">
  ${formRow({ label: 'Name', control: html`<input type="text" value="Avery" aria-label="Name">` })}
  ${formRow({ label: 'Kind', hint: 'A hint under the control.', control: html`<select aria-label="Kind"><option>group</option><option>dm</option></select>` })}
  ${formRow({ label: 'Note', control: html`<textarea rows="2" aria-label="Note"></textarea>` })}
</div></div>`)}

${section('Folds', html`
  ${fold({ id: 'kit.one', title: 'Closed until you open it', meta: '3 ITEMS', body: html`<div class="panel-body">The state is remembered per browser.</div>` })}
  ${fold({ id: 'kit.two', title: 'Open by default', open: true, body: html`<div class="panel-body">Long pages use these so a phone isn't one endless scroll.</div>` })}`)}

${section('Alerts', html`<div class="panel">${alertList([
  { severity: 'high', title: 'Two spends for one outing', detail: 'A dinner was paid for twice on Saturday.', at: '02:10', href: '#kit' },
  { severity: 'warn', title: 'A plan agreed in texts has no plan', detail: 'Coffee on Sunday.', at: '02:10' },
  { severity: 'info', title: `A worst case ${LONG}`, detail: LONG, at: '02:10' },
])}</div><div class="panel" style="margin-top:8px">${alertList([])}</div>`)}

${section('The live line', liveLine({ at: '20:14', parts: ['the cafe', 'talking about her new job', "she's laughing", 'his phone buzzed, he put it face down'] }))}

${section('The stream', html`<div class="panel">${stream([
  { at: '19:02', kind: 'thought', text: 'just go' },
  { at: '19:20', kind: 'body', text: 'starving' },
  { at: '19:41', kind: 'feeling', text: 'something off about today', note: 'after the meeting' },
  { at: '20:05', kind: 'thought', text: LONG },
])}</div><div class="panel" style="margin-top:8px">${stream([])}</div>`)}

${section('Two columns', html`
  ${twoCol({ title: 'Dinner with a friend', at: 'Sat 19:30', differs: true, leftLabel: 'What he leaned to', left: 'Stay in (0.72)', rightLabel: 'What he did', right: 'Went anyway' })}
  ${toldRows([{ title: 'Newest whole, the rest folded on a phone', at: 'Sun 21:40', told: 'Early night. I earned it.', drove: 'He was tired (38), and nothing was planned.' }, { title: 'An earlier one', at: 'Sun 19:05', told: 'It was too far to go.', drove: 'He was leaning go (61%). The draw came up stay.', differs: true }])}
  ${toldRow({ title: 'Skipped the gym', at: 'Sun 08:10', told: 'Too tired after a long week. Next time.', drove: 'He was leaning go (61%). The draw at the deadline came up stay: chance, not a reason. At the time: energy 41, rain.', differs: true })}`)}

${section('Interests and opinions', html`<div class="panel">
  ${stanceRow({ topic: 'Cafes', kind: 'interest', value: 0.72, trend: 'up', confidence: 0.6, whyId: 'cafes' })}
  ${stanceRow({ topic: 'Live music', kind: 'interest', value: 0.2, trend: 'down', whyId: 'music' })}
  ${stanceRow({ topic: 'Working from home', kind: 'opinion', value: 0.55, trend: 'flat', pinned: true, whyId: 'wfh' })}
  ${stanceRow({ topic: 'This city in summer', kind: 'opinion', value: -0.6, trend: 'down', confidence: 0.9, whyId: 'summer' })}
  ${stanceRow({ topic: LONG, kind: 'opinion', value: 0, whyId: 'long' })}
</div>`)}

${section('Dreams', html`
  ${dreamCard({ night: 'Sat night', tone: 'bad', vivid: true, text: 'The office again, but the stairs kept going down, and someone from school was at the desk asking for a report he had never heard of.' })}
  ${dreamCard({ night: 'Tue night', tone: 'flat', scenes: [{ place: 'the old flat', person: 'his sibling', twist: 'everything a little too small' }, { place: 'a station', twist: 'the trains had no doors' }] })}`)}
`;

export function mount(ctx) {
  let seg = 'a';
  render(ctx.root, page(seg));
  initFolds(ctx.root);
  ctx.listen(ctx.root, 'click', (e) => {
    const t = e.target;
    const segBtn = t.closest?.('[data-seg]');
    if (segBtn) {
      seg = segBtn.dataset.seg;
      render($(ctx.root, '#kitSeg'), segments([['a', 'Today'], ['b', 'This week', 3], ['c', 'All of it'], ['d', 'Long section name']], seg));
    } else if (t.closest?.('#kitFlash')) {
      flash('A toast');
    } else if (t.closest?.('#kitSheet') || t.closest?.('[data-why]')) {
      const sheet = openSheet({
        label: 'Why',
        content: html`<p>A sheet from the bottom on a phone and from the side on desktop. A poll can't re-render it away, and leaving the page closes it.</p>${stream([{ at: 'Sat', kind: 'thought', text: 'A good evening there.' }, { at: 'Sun', kind: 'feeling', text: 'Went back on his own.' }])}<button type="button" id="kitSheetFlash">A toast from inside</button>`,
      });
      ctx.onDispose(sheet.close);
      sheet.body.querySelector('#kitSheetFlash')?.addEventListener('click', () => flash('A toast over the sheet'));
    }
  });
}
