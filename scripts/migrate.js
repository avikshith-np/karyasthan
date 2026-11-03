// Database schema ladder (spec 006, R12).
//
//   node scripts/migrate.js            report the schema version and pending steps (changes nothing)
//   node scripts/migrate.js --apply    back up the database, then apply pending steps
//
// Boot (npm start) applies pending steps too; this is for doing it by hand.
// Honours DB_PATH (e.g. a rehearsal copy).

import fs from 'fs';
import { config } from '../src/utils/config.js';
import { safePath } from '../src/utils/pathGuard.js';
import { runMigrations, closeDb, LATEST_SCHEMA_VERSION } from '../src/memory/db.js';

const apply = process.argv.includes('--apply');
const dbPath = safePath(config.dbPath);

try {
  if (!apply) {
    if (!fs.existsSync(dbPath)) {
      console.log(`No database at ${dbPath}. Run with --apply (or start the bot) to create it at v${LATEST_SCHEMA_VERSION}.`);
    } else {
      const r = runMigrations({ apply: false });
      console.log(`Database ${dbPath}: schema v${r.from}, code expects v${LATEST_SCHEMA_VERSION}.`);
      if (r.from > LATEST_SCHEMA_VERSION) {
        console.log('The database is NEWER than this code — the bot will refuse to start. Deploy the matching code.');
        process.exitCode = 1;
      } else {
        console.log(r.pending.length
          ? `Pending: ${r.pending.join(', ')}\nRun with --apply to back up and apply them.`
          : 'Up to date.');
      }
    }
  } else {
    console.log(`Migrating ${dbPath} ...`);
    const r = runMigrations({ apply: true });
    if (r.backup) console.log(`Backup: ${r.backup}`);
    console.log(r.applied.length ? `Applied: ${r.applied.join(', ')}` : 'Nothing to apply.');
    console.log(`Schema now v${r.to}.`);
  }
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
