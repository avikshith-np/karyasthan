// Tables on a phone. Every `table.data` that wouldn't read well at phone width turns into
// cards: one per row, each cell labelled from its column head. Run from the shell's content
// observer, before paint, so a poll that re-renders a table never flashes the wide layout.
//
//   table.data.no-cards   opts out (a page with its own compact rows)
//
// A table goes to cards with 5+ columns (it fits only by squeezing its text to one word a
// line) or when it is wider than its box; a short one stays a table.
const PHONE = '(max-width: 720px)';
const MIN_COLUMNS = 5;
const SHORT_CHARS = 16;

/** A value that can share a line with others in its card. */
const isShort = (td) => td.colSpan === 1 && td.textContent.trim().length <= SHORT_CHARS && !td.querySelector('input, select, textarea');

/** Column labels, honouring colspan in the head. */
function heads(table) {
  const row = table.tHead?.rows[0];
  if (!row) return null;
  const out = [];
  for (const th of row.cells) {
    const text = th.textContent.trim();
    for (let i = 0; i < th.colSpan; i++) out.push(text);
  }
  return out;
}

/** Copy a table's column heads onto its cells, for a page laying out its own rows on a phone. */
export function labelCells(table) {
  const names = heads(table);
  if (names) label(table, names);
}

function label(table, names) {
  for (const body of table.tBodies) {
    for (const tr of body.rows) {
      let col = 0;
      for (const td of tr.cells) {
        // A cell spanning the row is a message ("QUEUE EMPTY"), not a value of a column.
        if (!td.hasAttribute('data-label')) {
          td.setAttribute('data-label', td.colSpan > 1 ? '' : names[col] ?? '');
          if (isShort(td)) td.classList.add('c-short');
        }
        col += td.colSpan;
      }
    }
  }
}

export function syncTables(root) {
  if (!globalThis.matchMedia?.(PHONE).matches) return;
  for (const table of root.querySelectorAll('table.data:not(.no-cards)')) {
    const names = heads(table);
    if (!names) continue;
    if (!table.classList.contains('cards')) {
      const box = table.parentElement;
      if (names.length < MIN_COLUMNS && !(box && table.scrollWidth > box.clientWidth + 1)) continue;
      table.classList.add('cards');
    }
    label(table, names);
  }
}

/** Run again when the screen crosses phone width. Returns an unsubscribe. */
export function onPhoneChange(fn) {
  const mq = globalThis.matchMedia?.(PHONE);
  mq?.addEventListener?.('change', fn);
  return () => mq?.removeEventListener?.('change', fn);
}
