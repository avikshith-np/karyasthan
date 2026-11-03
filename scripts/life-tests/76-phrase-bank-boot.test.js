// Plan 020 H2, batch 3 finding 34: a phrase bank is checked at boot against today's names. A real startLife, a bank line holding a
// real person's name, the switch on. Names read → the line is dropped. Real names or venue names can't be read → no bank at all: life
// comes up, English lines, an evt:'issue', whatever was running before; the next boot retries. A scratch DB and a scratch bank file.
import { setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { config } from '../../src/utils/config.js';
import { logger } from '../../src/utils/logger.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { setJev as setDecisionJev } from '../../src/life/decisions.js';
import { setJev as setClaimsJev } from '../../src/life/claims.js';
import { __setBankFileForTest, bankStatus, bankVersion, voiceLine } from '../../src/life/phraseBank.js';
import { catalogueHash } from '../../src/life/phraseCheck.js';
import * as life from '../../src/life/index.js';

const { db, cleanup } = await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const clock = fakeClock(zonedToUnix(2026, 10, 27, 6, 0, world.timezone));
setClock(clock.fn);
globalThis.fetch = async () => { throw new Error('network is off in life tests'); };
setDecisionJev(fakeJev(() => ({ pick: jevChoice('stay', { go: 0.2, late: 0.1, stay: 0.7 }) })).fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('commitment', { none: 0.05, claim: 0.05, commitment: 0.9 }) })).fn);

db.prepare('INSERT INTO people (jid, push_name, real_name) VALUES (?, ?, ?)').run('15550000001@s.whatsapp.net', 'Nadia', 'K Nadia');

const SCRATCH = path.join(PROJECT_ROOT, 'data', `phrases-boot-${process.pid}`);
fs.mkdirSync(SCRATCH, { recursive: true });
const FILE = path.join(SCRATCH, 'phrases.json');
fs.writeFileSync(FILE, JSON.stringify({ v: 1, version: 'gen-boot', generatedAt: 1, model: 'stub', catalogue: catalogueHash(), banks: { thought: { 'ugh, rain': [{ t: 'nadia again, ugh' }], 'rain. great': [{ t: 'zuvo maku' }] } } }));
__setBankFileForTest(FILE);
config.life.phraseBanks = true;

// Only the reads named fail; the rest of the boot goes on.
const realPrepare = db.prepare.bind(db);
let failPeople = false;
let failVenues = false;
db.prepare = (sql) => {
  if (failPeople && /FROM people/.test(sql)) throw new Error('the people read failed');
  const st = realPrepare(sql);
  if (failVenues && /type IN/.test(sql)) {
    const all = st.all.bind(st);
    st.all = (...args) => { if (args.includes('place.created')) throw new Error('the venue read failed'); return all(...args); };
  }
  return st;
};
const issues = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (o, ...rest) => { if (o?.evt === 'issue' && o?.where === 'life.phrases') issues.push(o); return realWarn(o, ...rest); };

const opts = {
  world, timers: false, isEnabled: () => true, seed: 42, getSock: () => fakeSock(), processMessage: async () => {},
  loadMessage: () => null, isGroupMuted: () => false, isMember: () => true, sleep: async () => {},
};
const named = () => voiceLine('thought', 'ugh, rain', {}, 'x');
const plain = () => voiceLine('thought', 'rain. great', {}, 'x');

try {
  section('names can be read');
  await life.startLife(opts);
  eq('life is up', life.isLifeOn(), true);
  eq('the bank is loaded', [bankStatus().source, bankVersion()], ['phrases.json', 'gen-boot']);
  eq('the line with a real name is dropped, its slot is English', [bankStatus().rejected.real_name, named()], [1, 'ugh, rain']);
  eq('the rest of the bank speaks', plain(), 'zuvo maku');
  eq('no issue', issues.length, 0);
  await life.stopLife();

  section('the real names can\'t be read at boot');
  failPeople = true;
  await life.startLife(opts);
  eq('life still comes up', life.isLifeOn(), true);
  eq('no bank is loaded, not even the one that was running', [bankStatus().source, bankVersion()], [null, null]);
  eq('every line is English', [named(), plain()], ['ugh, rain', 'rain. great']);
  check('an issue says which read', issues.length === 1 && issues[0].read === 'real_names', issues);
  await life.stopLife();

  section('the next boot retries');
  failPeople = false;
  issues.length = 0;
  await life.startLife(opts);
  eq('loaded again, the name still dropped', [bankStatus().source, named(), plain()], ['phrases.json', 'ugh, rain', 'zuvo maku']);
  await life.stopLife();

  section('the venue names can\'t be read at boot');
  life.__resetGeoForTest();
  failVenues = true;
  await life.startLife(opts);
  eq('life still comes up, no bank, English', [life.isLifeOn(), bankStatus().source, plain()], [true, null, 'rain. great']);
  check('an issue says which read', issues.some(o => o.read === 'venue_names'), issues);
  await life.stopLife();
  failVenues = false;
  life.__resetGeoForTest();
  await life.startLife(opts);
  eq('and the next boot retries', [bankStatus().source, plain()], ['phrases.json', 'zuvo maku']);
  await life.stopLife();
} finally {
  db.prepare = realPrepare;
  __setBankFileForTest(null);
  config.life.phraseBanks = false;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  cleanup();
}
report();
