// Live bug (2026-10-29): the arc seed's budget gate (seed.js generationGate) was
// only ever injected by tests, so in production every automatic seed — and the
// owner's regenerate — failed closed with reason 'budget' and the example seed
// stayed in force. The life facade now injects 008's gate into story.attach().
// Static wiring checks + one runtime call of the facade's gate on a scratch DB.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { section, check, report, setupScratchDb } from './_helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

section('wiring: life facade → story.attach({ mindBudgetOk }) → seed gate');
{
  const life = read('src/life/index.js');
  const attach = life.slice(life.indexOf('story.attach({'), life.indexOf('story.applyPendingWithdrawals();'));
  check('life facade passes opts.mindBudgetOk to story.attach', /mindBudgetOk:\s*typeof r\.opts\.mindBudgetOk === 'function'/.test(attach));
  check('the life facade imports no src/mind/ module', !/['"`][^'"`]*\/mind\/[^'"`]*['"`]/.test(life));
  const main = read('src/index.js');
  check('index.js imports budgetOk from the mind facade', /import \{[^}]*budgetOk as mindBudgetOk[^}]*\} from '\.\/mind\/index\.js'/.test(main));
  const call = main.slice(main.indexOf('startLife({'), main.indexOf('startMind({'));
  check('index.js hands it to startLife', /mindBudgetOk:\s*\(kind\)\s*=>\s*mindBudgetOk\(kind\)/.test(call));
  const story = read('src/life/story/index.js');
  check('story.attach keeps rt.mindBudgetOk', /mindBudgetOk:\s*typeof rt\.mindBudgetOk === 'function'/.test(story));
  const uses = story.match(/testDeps\.mindBudgetOk \?\? att\??\.mindBudgetOk/g) || [];
  check('the automatic seed and the owner regenerate both use it', uses.length >= 2, `uses=${uses.length}`);
  check('the story layer still imports no src/mind/ module', !/from ['"][^'"]*\/mind\//.test(story) && !/import\(['"][^'"]*\/mind\//.test(story));
  check('the mind facade exports budgetOk', /export function budgetOk\(/.test(read('src/mind/index.js')));
}

section('runtime: the facade gate answers { ok, reason }');
{
  await setupScratchDb();
  const mind = await import('../../src/mind/index.js');
  const b = await mind.budgetOk('sleep');
  check('budgetOk(sleep) returns an object with a boolean ok', b && typeof b.ok === 'boolean', JSON.stringify(b));
}

report();
