// 020 D1: a think reads digests up to 48 h old. Each section states how old it is, and yesterday's
// "today note" is no longer offered as today's: the think could pick it and carry it on his self-state.
// Scratch DB, fake clock, no network.
import { TEST_ZONE, OFFSET_ZONE } from '../test-zone.js';
import { setupScratchDb, fakeClock, blockNetwork, section, check, eq, report, HOUR } from './_helpers.js';

await setupScratchDb();
blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = TEST_ZONE;
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const digest = await import('../../src/mind/digest.js');
const { buildLabelMap } = await import('../../src/mind/labels.js');
const { bundleEntries } = await import('../../src/mind/think.js');

// Tue 27 Oct, 12:00 local.
const noon = Date.UTC(2026, 9, 27, 6, 30) / 1000;
const fc = fakeClock(noon);
clock.setClock(fc.fn);
const G = '120363000000840001@g.us';
const insert = (chat, at) => {
  fc.set?.(at);
  return store.insertDigest({ chatJid: chat, originKind: 'group', fromRowid: 0, toRowid: 1, periodStart: at - HOUR, periodEnd: at, createdAt: at,
    summary: 'they talked', todayNote: 'the match tonight', tone: 'warm', threads: [] });
};

section('a digest states its age');
{
  const fresh = insert(G, noon - 600);
  fc.set?.(noon);
  const map = buildLabelMap([{ chatJid: G, digestId: fresh, name: 'Chat' }]);
  const b = digest.digestBundle(map);
  check('within the hour', b.text.includes('"Chat" (as of the last hour)'), b.text.slice(0, 200));
  check('today\'s note is offered', b.text.includes('C1.today: the match tonight'));
}

section('yesterday\'s digest: the age, and its note isn\'t "today" any more');
{
  const old = store.getDigest(insert(`${G}x`, noon - 26 * HOUR));
  fc.set?.(noon);
  check('stored with its time', old.createdAt === noon - 26 * HOUR, old.createdAt);
  eq('digestIsToday', digest.digestIsToday(old, noon), false);
  const map = buildLabelMap([{ chatJid: old.chatJid, digestId: old.id, name: 'Old chat' }]);
  const b = digest.digestBundle(map);
  check('states 26 h', b.text.includes('"Old chat" (as of 26 h ago)'), b.text.slice(0, 200));
  check('no today note to pick', !b.text.includes('.today:'), b.text);
  eq('its summary still reaches the think', b.text.includes('summary: they talked'), true);
  const [entry] = bundleEntries([old.chatJid], noon);
  eq('the think\'s label map has no today ref for it, so it can\'t be picked', buildLabelMap([entry]).C1.hasToday, false);
  const [fresh] = bundleEntries([G], noon);
  eq('…a fresh one keeps it', buildLabelMap([fresh]).C1.hasToday, true);
}

section('the edges of "today"');
{
  const d = (at) => ({ createdAt: at });
  eq('same local date', digest.digestIsToday(d(noon - 5 * HOUR), noon), true);
  // 23:50 Mon → 00:20 Tue: a late evening's note past midnight is still about the day he's in.
  const justPast = Date.UTC(2026, 9, 27, 0, 20) / 1000;
  eq('past midnight, under 6 h', digest.digestIsToday(d(justPast - 1800), justPast), true);
  eq('past midnight, past 6 h', digest.digestIsToday(d(justPast - 7 * HOUR), justPast), false);
  eq('no time', digest.digestIsToday({}, noon), false);
}

report();
