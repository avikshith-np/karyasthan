import fs from 'fs';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { onDeviceCommand } from './device.js';
import { stopSession } from './session.js';
import { startInstagramScheduler, stopInstagramScheduler } from './scheduler.js';
import { closeStaleSessions, insertDeviceLog, pruneInstagram } from '../memory/igStore.js';
import { ensureTasteCard } from './taste.js';

// Boot/shutdown/maintenance for the Instagram reels feature (specs/005). Nothing here
// touches the phone: sessions start from the scheduler (skill on) or the dashboard.
// Boot also generates the taste card once (taste.json missing).

export function startInstagram() {
  if (!config.instagram.deviceSerial || !config.instagram.deviceModel) {
    logger.info('Instagram reels: no phone configured (IG_DEVICE_SERIAL / IG_DEVICE_MODEL) — skipped');
    return;
  }
  const stale = closeStaleSessions();
  if (stale) logger.info({ count: stale }, 'Closed Instagram sessions left open by the last run');
  onDeviceCommand((e) => {
    try { insertDeviceLog(e); } catch (err) { logger.debug({ err: err.message }, 'device log write failed'); }
  });
  startInstagramScheduler();
  // First boot with a phone: write taste.json from the persona (one clerk call, `ig.taste`).
  // Until it exists (or if the call fails — retried next boot) the judge uses the example card.
  ensureTasteCard().catch((err) => logger.warn({ evt: 'issue', err: err.message }, 'Instagram taste card not generated (using the example)'));
}

export function stopInstagram() {
  stopSession();
  stopInstagramScheduler();
}

/** 14-day retention for the device log and reel thumbnails (descriptions are kept). */
export function pruneInstagramData() {
  for (const file of pruneInstagram(14)) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}
