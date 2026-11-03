import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';

// One controller for the Instagram phone at a time, ACROSS processes (the live bot, a
// test harness, scripts/ig-probe.js). In-process sessions/shares/chat checks also hold
// `busy` in session.js; this file lock stops two processes swiping the same phone.
// A lock whose pid is alive is held for up to 6 h (a 30-min session plus its chat check
// may run past 30 min; only a pid reused after a reboot makes a live pid's lock stale);
// a dead pid's lock is taken over at once.

const LOCK = path.join(config.projectRoot, 'data', 'instagram', 'phone.lock');
const STALE_MS = 6 * 3600_000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function readPhoneLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf-8')); } catch { return null; }
}

/** Take the lock for `owner`; returns a release() or null if someone else holds it. */
export function acquirePhoneLock(owner) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, owner, at: Date.now() }), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = readPhoneLock();
        if (cur?.pid === process.pid && cur.owner === owner) fs.rmSync(LOCK, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const cur = readPhoneLock();
      if (cur && alive(cur.pid) && Date.now() - cur.at < STALE_MS) return null;
      fs.rmSync(LOCK, { force: true }); // stale: take over
    }
  }
  return null;
}
