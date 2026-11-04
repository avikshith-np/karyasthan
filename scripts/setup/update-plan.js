// What `npm run update` decides, as plain functions. No git, no files, nothing written.
// Tested by scripts/test-day-two.js.

/** Why this install can't be updated, in words; null when it can. Called as the facts come in: a fact not looked at yet isn't held against it. */
export function refusal(f) {
  const same = 'Nothing was changed.';
  if (!f.checkout) return `This folder isn't a git checkout of Karyasthan, so there's nothing to pull. ${same}`;
  if (f.branch !== 'main') {
    return `This install is on ${f.branch ? `the branch "${f.branch}"` : 'no branch'}. Update only ever touches main. ${same}`;
  }
  if (f.changed?.length) {
    const list = f.changed.slice(0, 5).join(', ') + (f.changed.length > 5 ? ` and ${f.changed.length - 5} more` : '');
    return `You've changed files the project tracks: ${list}. Commit them or put them back, then run this again. ${same}`;
  }
  if (f.upstream === '') return `main has no remote to pull from. ${same}`;
  if (f.fetchFailed) return `Couldn't reach ${f.upstream}, so there's no telling what's new. Check the connection and run this again. ${same}`;
  if (f.ahead > 0) return `main here has ${f.ahead} commit${f.ahead === 1 ? '' : 's'} ${f.upstream} doesn't, so it can't be fast-forwarded. Sort that out with git, then run this again. ${same}`;
  if (f.dbNewer) return `The database is newer (v${f.dbNewer.db}) than the code being pulled (v${f.dbNewer.code}). The bot would refuse it. ${same}`;
  return null;
}

/** Migration files from a folder listing, by number. The number is the schema version. */
export function migrationFiles(names) {
  return names.map((n) => n.split('/').pop()).filter((n) => /^\d{3}-.*\.js$/.test(n)).sort();
}
export const latestVersion = (files) => (files.length ? Number(files[files.length - 1].slice(0, 3)) : 0);

/** { will, from, to, newFiles }. Compares the files on both commits, and the database itself when it can. */
export function migrationPlan({ before, after, dbVersion = null }) {
  const had = new Set(before);
  const newFiles = after.filter((f) => !had.has(f));
  const to = latestVersion(after);
  const from = dbVersion ?? latestVersion(before);
  return { will: newFiles.length > 0 || (dbVersion != null && dbVersion < to), from, to, newFiles };
}

/** Lines for what's about to happen. */
export function describeUpdate({ count, migration, hasDb, packages, manager }) {
  const lines = [`${count} new commit${count === 1 ? '' : 's'}.`];
  if (hasDb) lines.push(migration.will ? `The database will be upgraded from v${migration.from} to v${migration.to} when it next starts.` : 'The database stays as it is.');
  lines.push(packages ? 'Packages changed, so they\'ll be reinstalled.' : 'Packages are the same, so that step is skipped.');
  lines.push(manager ? `It's running under ${manager}. It'll stop for a moment and start again.` : 'It isn\'t running, so it won\'t be started afterwards.');
  return lines;
}

/** The old code refuses a newer schema, so it can't simply be started. */
export const oldCodeRefuses = (dbVersionNow, oldLatest) => dbVersionNow != null && dbVersionNow > oldLatest;

/**
 * The exact lines to go back to the database from before an update. Printed, never run: it loses
 * every message since the backup, so a person chooses it.
 */
export function restoreSteps({ dbPath, backupDb, startCommand, quote, suffix }) {
  const q = quote;
  const aside = `${dbPath}.old-${suffix}`;
  return [
    `mv ${q(dbPath)} ${q(aside)}`,
    // Its write-ahead file goes with it: it may hold the newest messages, and it belongs to that copy.
    `mv ${q(`${dbPath}-wal`)} ${q(`${aside}-wal`)} 2>/dev/null || true`,
    `mv ${q(`${dbPath}-shm`)} ${q(`${aside}-shm`)} 2>/dev/null || true`,
    `cp ${q(backupDb)} ${q(dbPath)}`,
    `chmod 600 ${q(dbPath)}`,
    ...(startCommand ? [startCommand] : []),
  ];
}
