// One copy per install: two processes on one WhatsApp session knock each other off (440).
// data/.instance-lock holds the holder's pid. A lock whose process is gone, or is now something
// else, is stale and replaced. The bot takes it at boot, scripts/pair.js and first-check to link.
import fs from 'node:fs';
import path from 'node:path';

const OURS = /(^|\/)src\/index\.js( |$)|(^|\/)scripts\/(pair|first-check)\.js( |$)/;

export function lockPath(dataDir) { return path.join(dataDir, '.instance-lock'); }

function aliveAndOurs(pid) {
  try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return false; }
  try {
    // Node, running one of our scripts. NULs separate the arguments, so a folder may hold spaces;
    // pm2 renames its process to one string, "node <path>", padded with NULs.
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
    let [cmd, script] = parts;
    if (parts.length === 1) { const at = cmd.indexOf(' '); script = at < 0 ? '' : cmd.slice(at + 1); cmd = at < 0 ? cmd : cmd.slice(0, at); }
    return /(^|\/)node(js)?$/.test(cmd || '') && OURS.test(script || '');
  } catch { return true; }   // no /proc: trust the pid
}

/** { pid, what } of a live holder, or null. */
export function lockHolder(dataDir) {
  let text;
  try { text = fs.readFileSync(lockPath(dataDir), 'utf-8'); } catch { return null; }
  const m = text.match(/^(\d+) ?(.*)/);
  if (!m) return null;
  const pid = Number(m[1]);
  if (pid === process.pid || !aliveAndOurs(pid)) return null;
  return { pid, what: m[2] || 'it' };
}

/**
 * Takes the lock. Returns null when taken, else the holder. `allow(holder)` lets a process
 * through without taking it: the dashboard's own pairing job, under its parent bot.
 */
export function takeLock(dataDir, what = 'bot', { allow = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 3; i++) {
    const holder = lockHolder(dataDir);
    if (holder) return allow?.(holder) ? null : holder;
    try { fs.unlinkSync(lockPath(dataDir)); } catch { /* none */ }
    try {
      fs.writeFileSync(lockPath(dataDir), `${process.pid} ${what}\n`, { flag: 'wx', mode: 0o600 });
      process.once('exit', () => releaseLock(dataDir));
      return null;
    } catch (err) { if (err.code !== 'EEXIST') throw err; }   // another start won the race: look again
  }
  return lockHolder(dataDir);
}

export function releaseLock(dataDir) {
  try {
    if (fs.readFileSync(lockPath(dataDir), 'utf-8').startsWith(`${process.pid} `)) fs.unlinkSync(lockPath(dataDir));
  } catch { /* gone */ }
}
