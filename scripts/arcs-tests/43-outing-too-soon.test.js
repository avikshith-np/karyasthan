// An outing he can't make in time (audit 2026-10-30): the Director's too_soon
// refusal carries `earliestAt` — the first 5-minute mark he can still get ready
// for and get to (outing.earliestStart: prep + the trip from where he is, re-
// planned at that time) — and previewing the same outing at that start passes;
// a bundle part keeps it with its part index. The prompt's catalogue gives each
// place its `leadMin` (the same code) and the charter tells the model to start a
// "right now" outing no sooner. Example world, fake clock, stubbed models.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours } from './_helpers.js';
import * as director from '../../src/life/story/director.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { earliestStart, START_STEP_SEC } from '../../src/life/story/outing.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed, mid-morning
const S = () => life.getState();

async function refusal(action) {
  try { await director.preview(action, { relax: true }); return null; } catch (e) { return e; }
}

section('too_soon carries the earliest start he can make');
{
  const now = clock.now();
  const action = { kind: 'scene', shape: 'outing', placeId: 'place:cinema', castIds: ['cast:flatmate'], when: { inMinutes: 10 }, minutes: 120 };
  const e = await refusal(action);
  eq('a 10-minute outing across town → refused too_soon', e && `${e.code}:${e.reason}`, 'refused:too_soon');
  const at = e?.earliestAt;
  check('earliestAt: an integer, after now, on a 5-minute mark', Number.isSafeInteger(at) && at > now && at % START_STEP_SEC === 0, String(at));
  eq('…the same as outing.earliestStart', at, earliestStart({ state: S(), now, world }, { placeId: 'place:cinema' }));
  check('…at least getting ready (20 min) away', at - now >= 20 * 60, String((at - now) / 60));
  const { when, ...rest } = action;
  void when;
  let ok = null;
  try { ok = await director.preview({ ...rest, startAt: at }, { relax: true }); } catch (err) { ok = err; }
  check('previewing it at earliestAt passes (the page\'s MOVE TO)', ok && !(ok instanceof Error) && ok.events.some(x => x.type === 'decision.opened'), ok?.message);
  const p = await director.apply(ok.previewId, ok.fingerprint);
  check('…and applies', Array.isArray(p.eventIds) && p.eventIds.length > 0);
}

section('a bundle part keeps earliestAt with its index');
{
  const e = await refusal({ kind: 'bundle', actions: [
    { kind: 'quick', button: 'tired' },
    { kind: 'scene', shape: 'outing', placeId: 'place:restaurant', castIds: [], when: { inMinutes: 10 }, minutes: 90 },
  ] });
  eq('refused too_soon at part 1', e && [e.reason, e.part], ['too_soon', 1]);
  check('…with earliestAt', Number.isSafeInteger(e?.earliestAt));
}

section('the prompt: leadMin per place, and the charter rule');
{
  const now = clock.now();
  const { model } = promptMod.buildCatalogue(S(), world, now, world.timezone);
  const cinema = model.places.find(p => p.id === 'place:cinema');
  check('a place carries leadMin (minutes to the earliest start)', Number.isInteger(cinema?.leadMin) && cinema.leadMin >= 20, JSON.stringify(cinema));
  eq('…the same code as the too_soon fix', cinema?.leadMin, Math.ceil((earliestStart({ state: S(), now, world }, { placeId: 'place:cinema' }) - now) / 60));
  check('the charter says a "right away" outing starts no sooner than leadMin',
    /right away/.test(promptMod.PROMPT_CHARTER) && /"leadMin"/.test(promptMod.PROMPT_CHARTER));
}

await stopLife();
report();
