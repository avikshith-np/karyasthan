# Dashboard design system (plan 020 I1–I3)

Dark only (owner, 2 Nov 2026): no light theme, no `prefers-color-scheme`. Scanlines, vignette and the red glow are the identity and stay.

Labels say what the thing is: every word on screen tells the owner something true and useful, or it goes (owner, 3 Nov 2026; `test-dashboard` `plain words:`).

## Type

Every `font-size` in `public/css/` and the pages uses a token from `css/tokens.css` (`--t-micro` … `--t-stat`), named for what it is for. `@media (max-width: 900px), (pointer: coarse)` redefines the small steps, so one rule moves the whole app: labels never under 11 px, values and running text at least 14 px. Desktop keeps its sizes. SVG text is sized in viewBox units and stays in px. New code: use a token, never a px size (`test:dashboard` `base:` checks the CSS files).

## Touch (`css/touch.css`, loaded last)

- **Hover** sits in `@media (hover: hover) and (pointer: fine)`, or a tap would leave it stuck. A hover rule shared with a state class (`.is-sel`) is split so the state stays ungated.
- **`(pointer: coarse)`:** fields are 16 px (`!important`, because some have inline sizes; iOS zooms into anything smaller and stays zoomed), controls at least `--tap` (44 px), standalone links in cells and panel heads get the same height. Zoom is never disabled.
- **Press feedback** is `:active`, on every input type.
- **Safe areas:** `--safe-t/r/b/l`; anything fixed to an edge adds its inset.
- **Heights:** a `vh` line is followed by a `dvh` line, because the URL bar moves on phones.
- **Filter rows** use `.toolbar` (wraps under 900 px), never a bare inline grid.

## Checking a slice

```bash
node scripts/dash-tests/preview-server.js --days 7   # scratch DB, example world, 127.0.0.1:7073, admin / preview; --write for write mode
node scripts/dash-tests/shots.js --out <dir> --widths 390x844,320x568,844x390,1440x900
```

`shots.js` screenshots every route and measures sideways page scroll, fields that zoom on iOS, text under 11 px, targets under 40 px and console errors, in Chromium emulation. Sticky hover, safe areas, the keyboard and tap feel need a real phone.

## The shell

- **One registry** (`js/routes.js`) drives the router, the sidebar and the tab strips: `section`, `nav` (a sidebar link), `tabs` (the strip a route sits in), `navKey` (the link it lights). Moving a page in the nav never changes its address; `test:dashboard` `shell:` keeps a list of every old address. `#` opens Now, `#status` still opens Status. A new page goes in the registry and needs no shell code.
- **Sections:** Life (Now, Day + Timeline, People, Phone, Mind, Story + Director, Pending, Journal, Wallet, Map), Chats (Groups, Contacts, Search, Memories, Decisions, Bills, Instagram), Control (Status, Settings, Identity, Skills, Usage, Logs, Public site, Audit). "People" is his cast (`#life/cast`); "Contacts" is the real people (`#people`).
- **Under 900 px** (owner, 2 Nov: "I actually like the left sidebar"): the same sidebar becomes a panel sliding in from the left, opened by the topbar's ≡ MENU (`components/drawer.js`). The page behind is inert while it's open, so Tab stays inside; Escape, the scrim, a swipe to the left and navigation close it; focus returns to the button (on navigation, to the page). It scrolls when it's taller than the screen. The menu button carries the total of the sidebar's badges.
- **Sheets** (`components/sheet.js`, for page content, not the nav): `openSheet({label, content, onClose})` is a modal `<dialog>` outside `#content`: bottom sheet on a phone, side panel on desktop. The browser provides the focus trap, Escape, the inert page and focus back to the opener; the scrim, CLOSE and a drag on the handle close it too. A poll re-rendering the page can't touch it; navigation closes it. A page opening one adds `ctx.onDispose(s.close)`.
- **Badges:** `nav.setBadges({ life: n, 'life/story': n, 'life/pending': n })` paints the sidebar, the tabs and the menu button. Today: open alerts on Now (`life.alerts` on `/api/status`, absent is fine), Ask-me cards + tray on Pending, those + proposals on Story (`/api/arcs/status`, at most once a minute, not while the tab is hidden).
- **Reaching the server** (`core/api.js`): a 401 renews the session once from the browser's saved login and repeats the request; a write with no CSRF cookie does the same first. `onApiHealth` → the notice above the page: CONNECTION LOST · RETRYING (asks again every 5 s and clears itself) or SESSION ENDED + SIGN IN AGAIN. A browser remembers a failed import, so a page whose code couldn't load reloads once when the server is back.
- **Readonly:** mark a write control `data-write`. While the server is readonly the shell disables every one of them, however the page re-renders, and the topbar shows RO. The server refuses the write regardless.

## Checking the edge cases

`node scripts/dash-tests/edges.js [--only kit,write,phone,people,wallet,map,settings,chats,mind,golive,dialogs,shell,empty,worst] [--out <dir>]` starts its own preview servers. golive: GO LIVE with the mind skill on (`preview-server.js --mind`). dialogs: every question: same request as before, none on Escape, the scrim or KEEP IT, plus real writes, PURGE and media sends to a fake socket (`--sends`: DRY_RUN off, `SENT` lines on stdout, the only outside answers are two fakes). kit: the shared pieces with worst-case rows at 320, 390, landscape, 1440. write: real writes through the phone UI on a scratch DB (a note added and deleted on its card, a skill toggled, a write after a dropped cookie, a toast from inside a sheet). shell: deep links, the sidebar panel by keyboard / scrim / swipe (320, 390, landscape), with a sheet or modal open, panels across a 30 s poll, a dropped session, no connection, the stream reconnecting, readonly. empty: a fresh install on every route (`preview-server.js --empty`). worst: very long names on every route at 320 px (`--worst`).

## Shared pieces

`components/views.js` + `css/views.css`, shown with example and worst-case data on `#kit` (by address, not in the nav). Each returns html``; the page owns the fetching and wiring: `kpi`, `fold` + `initFolds` (a panel that folds and remembers), `segments` (one section at a time), `formRow`, `alertRow` / `alertList`, `liveLine` (sticks under the topbar on a phone), `streamRow` / `stream`, `twoCol` (thought vs deed, told himself vs drove it), `stanceRow` (an interest grows from the left, an opinion from the centre; `whyId` adds a WHY button for the page to open a sheet), `dreamCard`. A new piece goes here and on `#kit`; `test:dashboard` checks every value is escaped and every piece is shown.

**Folds:** `fold({id, title, meta, open, body})` for a panel; in a page's static markup, `<details class="fold-in" data-fold="…" data-wide-open>` around a section of a panel or `class="subfold"` inside a panel body, with `fold-mark` in the summary. `initFolds(root)` restores them: `data-wide-open` means open on desktop and closed on a phone until opened, and a choice is remembered per browser. The form stays in the DOM while folded, so apply logic sees everything. The width is read once when the page mounts: a tablet rotated across 900 px keeps its folds as they were until the page is opened again. No links in a fold's head: a tap meant to open it lands on the link. The `?` button is fine.

**Asking first:** `askSheet({label, text, action, danger, reasonLabel, keep})` → `{ok, reason}`, instead of `window.confirm` / `prompt`. Focus starts on the safe choice. `danger` is for anything destructive or that really sends (PURGE, TAKE OFFLINE, GO LIVE, widening who may hear something): only its two buttons answer, no Escape, scrim or drag, and Enter in the reason field doesn't confirm. Leaving the page answers no. Life · Pending, Journal and Director still use browser dialogs until their slices. A preview modal can't open above a sheet: close the sheet first.

**Polls:** a page that polls compares what it got with what's on screen and repaints only what changed, so an open picker, a scroll position, a selection and focus survive. Anything you type goes in a sheet or isn't repainted.

**Tables on a phone** (`components/tables.js`, run by the shell after every render): under 720 px a `table.data` with 5+ columns, or wider than its box, becomes one card per row, each cell labelled from its column head. Values of 16 characters or fewer share a line. `table.data.no-cards` opts out, for a page with its own compact rows. Column heads must say what the cell holds, since they become the labels.

## Director, Story, Pending, Journal

- **Director** is one page of forms, so a strip (`sectionStrip`, `segments()`) shows a section at a time: TELL, DAY, BUILD, GOD, CONTROLS, ALL. ALL is the old page, unchanged. A panel carries `data-sec`; blocks with their own shell get it at mount. A phone (< 900 px) opens on TELL, a desktop on ALL; the choice is in `ld.director.seg`. `#life/director/<section>` opens one without changing what is remembered (Day's TONE → god, Map → build).
- Hidden sections stay in the DOM, so a switch or a poll keeps what was typed. `section.reveal(node)` is how anything that fills a form shows it (a draft's EDIT, an approved suggestion): the form's section opens first. Never call `scrollIntoView` on a form directly.
- Polled slots go through `slotPainter`, except FATE and PINS: a cancelled slider or mode preview has to snap back, so those re-render. A button a handler disabled must be re-enabled on failure, since a poll with nothing new no longer repaints it.
- The preview window's Escape stands down while a `dialog` is open above it, so a sheet answers its own Escape.
- **Story**: what waits comes before the board, a panel with nothing waiting goes under it (`.ls-wait.is-idle`, CSS order), an empty category is one line and sorts last. **Journal**: the night's actions sit on a row of their own.
- `--story` on the preview server seeds a tray claim, a proposal, an ask-me card and a heavy veto, and lets the stubbed Director prompt run: `edges.js --only director` writes through each of them. Rewinds set aside recent rows, so anything using the seed runs first.
- **Day's sheet** stays in the page's DOM (it is the side column on a wider screen), so it holds its own modal rules under 720 px: `.ld-side-scrim` after it, everything outside it `inert` (only what `openSide` set is released), focus back on close, released on rotate and on leaving the page. ≡ MENU is behind the scrim like behind any sheet: close it first.
- **Timeline's lane names** are a second SVG in the ribbon's grid cell (`.lt-ribbon-grid`, sticky left, 7.8% = the 78-unit gutter), so they stay while the ribbon scrolls and the two scales stay equal. It lets taps through.
- **A proposal's WHAT** is `proposalLine` (`life-story.js`), words built per kind from the payload, since the store keeps no summary. The raw payload sits behind DETAILS; an unknown kind shows only DETAILS. A new proposal kind needs a line here.

## Inner life on a phone

- **Stances** (Mind): what waits for approval first with its buttons on its own row, then what he holds, strongest first (`|value|`), then SET ASIDE folded. SURE is confidence in words; each row says INTEREST or OPINION. A blank RETURNS TO is refused, since `Number('')` is 0.
- **Dreams**: the day and time, not to the second; a dream over 480 characters shows its opening and READ THE REST (`dreamCut`, at a sentence); five show, OLDER DREAMS folds.
- **ON HIS MIND**: Now is the latest eight, newest first. Day reads in order, the last twelve with EARLIER folded (`dayThoughts`, key `thoughts.day.earlier`, outside `day.*` so the page's own fold count holds). Each row carries its kind for a screen reader (`.v-sr`), since the colour alone says it.
- **Read-only** now reaches sheets and the preview window: the shell watches the whole document, not just `#content`.
- `--inner` on the preview server seeds these with awkward lengths; `edges.js --only inner`.

## Batch 3 on a phone

- **Real thoughts** (`toldRows`): the newest whole, the rest under EARLIER on a phone, open on a desktop, so the stream below stays in reach. A thought keeps its two columns, stacked under 720 px.
- **HIS COMMITMENTS, Claim check's BY VOICE**: `no-cards` tables with their own rows under 900 px, since the generic label cards turned five or nine cells into soup. A commitment reads status and when, then what, then who and from where. A voice reads its name and rate, then its numbers, each under its label (`data-l`). HIS COMMITMENTS' note turns amber when something overdue or without a plan waits behind the fold.
- **Free topics**: why in running text, then the chip and what it cites; CITES goes amber when a chat is among them.
- **HOW THINGS STAND**: switched off, the header carries no "as of".
- **Claim check, Phrases**: once something is on the page a failed load flashes and leaves it, and an older answer never paints over a newer one.
- `--batch3` on the preview server seeds free topics, real thoughts and standing notes; `edges.js --only b3` serves commitments, claim checks and phrases with awkward lengths, and checks each real empty state too.

