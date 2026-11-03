// 019 his phone — privacy of the prompt surface and the public reader (owner chose full
// recall): his texts reach every chat (self origin, fictional people only), but a turn from
// around a heavy stretch only a DM or a call; nothing while imitating, under an embargo /
// over the self-mention budget (mode ≠ full) or during an active heavy stretch; a turn whose
// event left the log never shows; the block is fenced and capped, the newest texts kept; an
// unknown event (the origin can't be read) fails closed; the public reader skips heavy-window
// and undone turns. Scratch DB, no model.
import { TEST_ZONE } from '../test-zone.js';
import { section, check, eq, report, setupScratchDb } from './_helpers.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { setOriginLookup } from '../../src/life/innerState.js';
import * as store from '../../src/life/story/phone/store.js';
import { phoneMemory, publicPhone, MEMORY_MAX } from '../../src/life/story/phone/memory.js';

await setupScratchDb();
setOriginLookup(null);

const T = 1793300000;
const state = { at: T + 3600, cast: new Map([['cast:asha', { name: 'Asha Quill' }]]), story: { departed: {} }, excluded: new Set() };
function turn(text, { at = T, dir = 'out', heavyWindow = false } = {}) {
  const ev = appendEvent({ type: 'phone.message', actor: 'engine', at, payload: { castId: 'cast:asha', dir } });
  const id = store.insertPending({ castId: 'cast:asha', dir, trigger: 'evening', dueAt: at, createdAt: at });
  store.update(id, { status: 'live', eventId: ev.id, at, text, heavyWindow });
  return { id, eventId: ev.id };
}
const group = { chatJid: '120363000000000001@g.us', kind: 'group', members: ['15550001111@s.whatsapp.net'] };
const dm = { chatJid: '15550001111@s.whatsapp.net', kind: 'dm', members: ['15550001111@s.whatsapp.net'] };
const opts = { at: T + 3600, tz: TEST_ZONE, mode: 'full' };

section('every chat sees his texts (self origin, fictional people)');
const a = turn('hey, you up?', { at: T });
const b = turn('yes! cant sleep', { at: T + 60, dir: 'in' });
{
  const g = phoneMemory(state, group, opts);
  eq('one block in a group', g.length, 1);
  check('both sides, oldest first, fenced', /you → Asha: hey, you up\?[\s\S]*Asha → you: yes! cant sleep/.test(g[0]) && g[0].includes('<<<PHONE_NOTES') && g[0].includes('PHONE_NOTES>>>'), g[0]);
  eq('the same in a DM', phoneMemory(state, dm, opts), g);
}

section('nothing while imitating, under an embargo / over budget, during a heavy stretch');
{
  eq('imitating', phoneMemory(state, group, { ...opts, imitating: true }), []);
  eq('mode embargo', phoneMemory(state, group, { ...opts, mode: 'embargo' }), []);
  eq('mode tone', phoneMemory(state, group, { ...opts, mode: 'tone' }), []);
  eq('heavy stretch active', phoneMemory(state, group, { ...opts, heavyActive: true }), []);
}

section('a heavy-window turn: a DM or a call only; the public reader never');
const h = turn('thinking of you, hope your dad is ok', { at: T + 120, heavyWindow: true });
{
  check('not in a group', !phoneMemory(state, group, opts)[0]?.includes('hope your dad'));
  check('in a DM', phoneMemory(state, dm, opts)[0]?.includes('hope your dad'));
  check('in a call', phoneMemory(state, { ...dm, kind: 'call' }, opts)[0]?.includes('hope your dad'));
  const map = publicPhone([a.eventId, b.eventId, h.eventId]);
  eq('public: the two ordinary turns only', [...map.keys()].sort((x, y) => x - y), [a.eventId, b.eventId]);
}

section('a turn whose event left the log never shows; an unreadable origin fails closed');
{
  state.excluded.add(b.eventId);
  check('excluded → gone from the block', !phoneMemory(state, group, opts)[0]?.includes('cant sleep'));
  state.excluded.delete(b.eventId);
  store.markReverted(a.eventId);
  check('reverted row → gone, its words NULLed', !phoneMemory(state, group, opts)[0]?.includes('you up') && store.getMessage(a.id).text === null);
  eq('…and from the public reader', publicPhone([a.eventId]).size, 0);
  setOriginLookup(() => { throw new Error('db'); });
  eq('origin read throws → nothing', phoneMemory(state, group, opts), []);
  setOriginLookup(null);
}

section('capped: the newest texts win, ≤ 480');
{
  for (let i = 0; i < 12; i++) turn(`message number ${i} ${'z'.repeat(80)}`, { at: T + 600 + i * 60 });
  const g = phoneMemory(state, group, opts)[0] ?? '';
  check('≤ MEMORY_MAX + fence slack', g.length <= MEMORY_MAX + 8, g.length);
  check('the newest is in, the oldest out', g.includes('message number 11') && !g.includes('message number 0 '), g);
  eq('older than a day: none', phoneMemory(state, group, { ...opts, at: T + 3 * 86400 }), []);
}

report();
