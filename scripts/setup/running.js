// Is a copy running here, and who looks after it? Shared by setup, update and uninstall.
// The lock tells which copy is THIS install's: pm2 and systemd names are per user, not per
// folder, so a name alone could be another install's. A manager only counts when its pid is
// the lock holder's.
import { spawnSync } from 'node:child_process';
import { lockHolder } from '../../src/utils/instanceLock.js';

export function commandExists(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

export function pm2Has(name = 'karyasthan') {
  const r = spawnSync('pm2', ['pid', name], { encoding: 'utf-8' });
  return r.status === 0 && /^\d+$/.test(r.stdout.trim()) && r.stdout.trim() !== '0' ? r.stdout.trim() : '';
}

export function systemdPid(name = 'karyasthan') {
  const r = spawnSync('systemctl', ['--user', 'show', name, '--property=MainPID', '--value'], { encoding: 'utf-8' });
  const pid = r.status === 0 ? r.stdout.trim() : '';
  return /^\d+$/.test(pid) && pid !== '0' ? pid : '';
}

/** 'pm2', 'systemd', or null when nothing we can drive runs this pid. */
export function managerOf(pid) {
  if (String(pid) === pm2Has()) return 'pm2';
  if (String(pid) === systemdPid()) return 'systemd';
  return null;
}

const COMMANDS = {
  pm2: { stop: ['pm2', ['stop', 'karyasthan']], start: ['pm2', ['start', 'karyasthan']] },
  systemd: { stop: ['systemctl', ['--user', 'stop', 'karyasthan']], start: ['systemctl', ['--user', 'start', 'karyasthan']] },
};
export const startWords = { pm2: 'pm2 start karyasthan', systemd: 'systemctl --user start karyasthan' };

function drive(manager, verb) {
  const [cmd, args] = COMMANDS[manager][verb];
  return spawnSync(cmd, args, { stdio: 'ignore', timeout: 60000 }).status === 0;
}
export const stopManaged = (manager) => drive(manager, 'stop');
export const startManaged = (manager) => drive(manager, 'start');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The live holder of any of these lock folders, or null. */
export function holderOf(lockDirs) {
  for (const d of lockDirs) {
    const h = lockHolder(d);
    if (h) return h;
  }
  return null;
}

/** True once no copy holds a lock in these folders. */
export async function waitGone(lockDirs, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (!holderOf(lockDirs)) return true;
    if (Date.now() >= until) return false;
    await sleep(200);
  }
}

/**
 * The holder once one pid has kept the lock for steadyMs, or null at the timeout. The bot takes
 * the lock before it migrates, so a copy that dies on boot holds it briefly; under a manager
 * that restarts it, the pid keeps changing and it never counts as up.
 */
export async function waitSteady(lockDirs, { timeoutMs = 30000, steadyMs = 5000 } = {}) {
  const until = Date.now() + timeoutMs;
  let pid = null; let since = 0;
  for (;;) {
    const holder = holderOf(lockDirs);
    if (!holder) pid = null;
    else if (holder.pid !== pid) { pid = holder.pid; since = Date.now(); }
    else if (Date.now() - since >= steadyMs) return holder;
    if (Date.now() >= until) return null;
    await sleep(200);
  }
}
