import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { emitDashboardEvent } from '../dashboard/events.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import * as device from './device.js';
import { readReel, readOpenMedia, reelKey, detectBlocker, screenKind, find, shareSearchRows, looksLikeGroup, selectedChats } from './screens.js';
import { describeFrame, describeClip, descriptionText, extractFrames, thumbnailFromPng } from './describe.js';
import { judgeQuick, judgeFull } from './judge.js';
import { LiveWatcher } from './liveWatch.js';
import { tasteForJudge } from './taste.js';
import { writeShareCaption } from './caption.js';
import * as store from '../memory/igStore.js';
import { acquirePhoneLock, readPhoneLock } from './phoneLock.js';
import { checkChatInner } from './chat.js';
import { isSkillEnabled } from '../skills/skillRunner.js';

// Browsing sessions on the Instagram phone (specs/005). One session at a time: it wakes
// the phone, opens Reels, and for each reel reads the screen, describes it (one frame;
// a 15 s clip with audio when it looks promising), lets Jev judge it, then likes /
// saves-to-queue / skips and swipes on. Every reel is logged with its description.
// Sharing into the group goes through Instagram's own share sheet, exact group match.
//
// All phone access is via device.js (Instagram-only guard). Anything unexpected —
// another app in front, an Instagram security check, a screen we can't place — ends
// the session; the bot never improvises its way past it.

const THUMB_DIR = path.join(config.projectRoot, 'data', 'instagram', 'thumbs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

export class SessionError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

let current = null;   // live session state (see snapshot())
let busy = false;     // a session OR a queue share is using the phone
let alert = null;     // { kind, text, at } — Instagram needs a human; blocks everything until cleared

export function instagramState() {
  return {
    running: !!current,
    busy,
    session: current && {
      id: current.id, trigger: current.trigger, startedAt: current.startedAt, endsAt: current.startedAt + current.plannedMs,
      allowShare: current.allowShare, phase: current.phase, counts: current.counts, reel: current.reel,
    },
    alert,
  };
}

export function clearAlert() { alert = null; emit({ kind: 'alert', alert }); }

function emit(payload) { emitDashboardEvent('instagram', payload); }

function raiseAlert(kind, text) {
  alert = { kind, text, at: Date.now() };
  logger.warn({ kind, text }, 'Instagram needs attention — automation paused');
  emit({ kind: 'alert', alert });
}

// ── Day accounting (bot timezone) ────────────────────────────────────────────

export function startOfTodayUnix(tz = config.timezone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const secsIntoDay = (+parts.hour) * 3600 + (+parts.minute) * 60 + (+parts.second);
  return Math.floor(now.getTime() / 1000) - secsIntoDay;
}

export function dailyCounts() {
  const since = startOfTodayUnix();
  return { liked: store.countToday('liked', since), shared: store.countToday('shared', since) };
}

export function warmupState() {
  const first = store.firstSessionAt();
  const days = first ? (Date.now() / 1000 - first) / 86400 : 0;
  return { active: days < config.instagram.warmupDays, day: Math.floor(days) + 1, of: config.instagram.warmupDays };
}

/**
 * The daily share cap (IG_SHARES_PER_DAY), counted over sent reels since local midnight.
 * → { ok, shared, cap, reason }. Every path that sends a reel to the group checks it:
 * in-session shares and dashboard queue approvals alike.
 */
export function shareCapState() {
  const shared = dailyCounts().shared;
  const cap = config.instagram.sharesPerDay;
  return shared < cap
    ? { ok: true, shared, cap, reason: null }
    : { ok: false, shared, cap, reason: `daily share cap reached (${shared}/${cap} today, IG_SHARES_PER_DAY) — try again tomorrow` };
}

/**
 * May this session share a strong reel straight into the group? Never during the
 * account's warmup, nor past the daily cap. Outside warmup: a manual session only when
 * its "allow sharing" box was ticked, an automatic one only in 'auto' approval mode.
 * Otherwise the reel is saved to the queue. → { share, reason }
 */
export function inSessionShareGate({ allowShare = false } = {}) {
  const w = warmupState();
  if (w.active) return { share: false, reason: `warmup day ${w.day}/${w.of}` };
  if (!allowShare && config.instagram.approvalMode !== 'auto') return { share: false, reason: 'not allowed this session' };
  const cap = shareCapState();
  if (!cap.ok) return { share: false, reason: cap.reason };
  return { share: true, reason: null };
}

// ── Navigation helpers ───────────────────────────────────────────────────────

async function readScreen({ attempts = 2 } = {}) {
  const { nodes } = await device.dumpScreen({ attempts });
  const blocker = detectBlocker(nodes);
  if (blocker) {
    raiseAlert('checkpoint', blocker);
    throw new SessionError(`Instagram security check: ${blocker}`);
  }
  return nodes;
}

async function openReelsTab() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const nodes = await readScreen({ attempts: 4 });
    const kind = screenKind(nodes);
    if (kind === 'reels') return;
    const tab = find(nodes, 'clips_tab');
    if (kind !== 'sheet' && kind !== 'share_sheet' && tab) await device.tapNode(tab);
    else await device.back(); // an Instagram sheet/dialog is open; BACK is inside Instagram
    await sleep(2000);
  }
  throw new SessionError('could not reach the Reels tab');
}

async function swipeNext() {
  const x = Math.round(jitter(420, 660));
  await device.swipe(x, Math.round(jitter(1600, 1800)), x + Math.round(jitter(-40, 40)), Math.round(jitter(450, 650)),
    Math.round(jitter(180, 340)));
  await sleep(jitter(900, 1600));
}

async function saveThumb(id, jpeg) {
  if (!jpeg) return null;
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const file = path.join(THUMB_DIR, `${id}.jpg`);
  fs.writeFileSync(file, jpeg);
  return file;
}

// ── Sharing ──────────────────────────────────────────────────────────────────

async function closeShareSheet() {
  for (let i = 0; i < 3; i++) {
    let nodes;
    try { nodes = await readScreen(); } catch { return; }
    if (screenKind(nodes) !== 'share_sheet') return;
    await device.back();
    await sleep(800);
  }
}

/**
 * Share the reel that is on screen right now into the configured group, with `caption`.
 * Exact group-name match + group-looking row + verified selection, or it backs out.
 * Under DRY_RUN it stops before Send. Returns { sent, dryRun }.
 */
async function shareCurrentReel(caption) {
  const group = config.instagram.groupName;
  if (!group) throw new SessionError('IG_GROUP_NAME is not set');
  if (!/^[\x20-\x7E]+$/.test(group)) throw new SessionError('IG_GROUP_NAME must be plain ASCII to be typed');
  let nodes = await readScreen();
  const share = readOpenMedia(nodes).shareNode;
  if (!share) throw new SessionError('no Share button on this screen');
  await device.tapNode(share);
  await sleep(1800);
  try {
    nodes = await readScreen();
    const search = find(nodes, 'search_edit_text');
    if (!search) throw new SessionError('share sheet did not open');
    await device.tapNode(search);
    await sleep(700);
    await device.typeText(group);
    await sleep(2200);
    nodes = await readScreen();
    const rows = shareSearchRows(nodes).filter(r => r.name === group);
    if (rows.length !== 1) throw new SessionError(`expected exactly one chat named "${group}", found ${rows.length}`);
    if (!looksLikeGroup(rows[0])) throw new SessionError(`"${group}" is not a group chat (${rows[0].secondary || 'no members line'})`);
    if (!rows[0].toggle) throw new SessionError('group row has no select toggle');
    await device.tapNode(rows[0].toggle);
    await sleep(1200);
    nodes = await readScreen();
    const selected = selectedChats(nodes);
    if (selected.length !== 1 || selected[0] !== group) throw new SessionError(`selection check failed (${selected.join(', ') || 'nothing selected'})`);
    if (caption) {
      const box = find(nodes, 'direct_private_share_message_box');
      if (!box) throw new SessionError('no message box');
      await device.tapNode(box);
      await sleep(600);
      await device.typeText(caption);
      await sleep(800);
      nodes = await readScreen();
    }
    const send = find(nodes, 'direct_send_button_multi_select');
    if (!send) throw new SessionError('no Send button');
    if (config.dryRun) {
      logger.info({ group, caption }, 'DRY_RUN: reel share stopped before Send');
      await closeShareSheet();
      return { sent: false, dryRun: true };
    }
    await device.tapNode(send);
    await sleep(2500);
    await closeShareSheet();
    return { sent: true, dryRun: false };
  } catch (err) {
    await closeShareSheet().catch(() => {});
    throw err;
  }
}

/**
 * The caption a share types: the stored one ('' = none — the owner cleared it, or he
 * had nothing good to say), else (NULL) he writes one now.
 */
export async function captionForShare(reel, write = writeShareCaption) {
  if (reel.share_caption != null) return reel.share_caption;
  return Promise.resolve().then(() => write(reel, config.instagram.groupName)).catch(() => '');
}

async function shareReelRow(reel, { actor = null } = {}) {
  const caption = await captionForShare(reel);
  store.updateReel(reel.id, { share_state: 'sending', share_caption: caption, approved_by: actor ?? reel.approved_by });
  emit({ kind: 'queue' });
  try {
    const res = await shareCurrentReel(caption);
    store.updateReel(reel.id, res.sent
      ? { share_state: 'sent', shared_at: Math.floor(Date.now() / 1000), share_error: null }
      : { share_state: 'approved', share_error: 'dry run: stopped before Send' });
    emit({ kind: 'queue' });
    return res;
  } catch (err) {
    store.updateReel(reel.id, { share_state: 'failed', share_error: err.message });
    emit({ kind: 'queue' });
    throw err;
  }
}

/**
 * Share an approved reel from the queue. Queued reels were Saved in Instagram (their link
 * isn't readable on the phone), so this opens Search → Saved, finds the one saved reel by
 * that account (refused when the first saved items hold two by it), shares it and un-saves it.
 */
export async function shareFromQueue(reelId, { actor = null, caption, onApproved } = {}) {
  const reel = store.getReel(reelId);
  if (!reel) throw new SessionError('reel not found', 404);
  // Checked before anything is written: a vetoed, sent or never-queued reel (a stale
  // tab, a direct call) is refused as it is.
  if (!['queued', 'approved', 'failed'].includes(reel.share_state)) throw new SessionError(`reel is ${reel.share_state || 'not queued'}`);
  // The daily cap holds for approvals too (before the phone is touched); the reel stays
  // in the queue with the reason, ready for tomorrow.
  const cap = shareCapState();
  if (!cap.ok) {
    store.updateReel(reel.id, { share_error: cap.reason });
    emit({ kind: 'queue' });
    throw new SessionError(cap.reason);
  }
  // The owner's approval (and caption edit) lands only once the share will be tried.
  const approval = { share_state: 'approved', approved_by: actor ?? reel.approved_by, share_error: null };
  if (typeof caption === 'string') { approval.share_caption = caption; reel.share_caption = caption; }
  store.updateReel(reel.id, approval);
  emit({ kind: 'queue' });
  onApproved?.();
  return withPhone('queue share', async () => {
    let nodes = await toMainTabs();
    const searchTab = find(nodes, 'search_tab');
    if (!searchTab) throw new SessionError('no Search tab');
    await device.tapNode(searchTab);
    await sleep(2000);
    nodes = await readScreen();
    const savedBtn = nodes.find(n => n.id.endsWith(':id/explore_action_bar_secondary_button_stub') && /^Saved$/i.test(n.desc));
    if (!savedBtn) throw new SessionError('no Saved button on Search');
    await device.tapNode(savedBtn);
    await sleep(2500);
    // Saved tiles are labelled with the DISPLAY name ("Reel by Guinevere | Life in
    // Progress at row 1, …") while we know the username, so open tiles newest-first and
    // check the account on the opened reel (see openSavedReelBy).
    const onScreen = await openSavedReelBy(reel.account);
    const res = await shareReelRow(reel, { actor });
    if (res.sent) {
      // Un-save: the Saved list is only our queue.
      if (await unsaveOpenMedia().catch(() => false)) store.updateReel(reel.id, { saved: false });
    }
    return res;
  });
}

/**
 * Run `fn` with the phone: nothing else in this process (busy) or another process (file
 * lock) may be using it, no open alert, screen woken, NOT locked, Instagram in front.
 * The screen goes back to sleep afterwards.
 */
export async function withPhone(owner, fn) {
  if (alert) throw new SessionError(`paused: ${alert.text}`);
  if (busy) throw new SessionError('the phone is busy (a session, share or chat check is running)');
  const release = acquirePhoneLock(owner);
  if (!release) throw new SessionError(`the phone is in use by another process (${readPhoneLock()?.owner || 'unknown'})`);
  busy = true;
  try {
    await device.wake();
    await sleep(1500);
    if ((await device.lockState()).locked) {
      raiseAlert('locked', 'The phone is showing its lock screen. Set Screen lock to None (not Swipe) on the phone.');
      throw new SessionError('phone is locked (Screen lock must be None, not Swipe)');
    }
    await device.launchInstagram({ launcherPackages: config.instagram.launcherPackages });
    await sleep(2500);
    return await fn();
  } finally {
    busy = false;
    release();
    device.sleep().catch(() => {});
  }
}

/** Back out (inside Instagram) until the bottom tab bar is visible. Returns the screen. */
export async function toMainTabs() {
  let nodes = await readScreen({ attempts: 4 });
  for (let i = 0; i < 4 && !find(nodes, 'direct_tab'); i++) {
    await device.back();
    await sleep(1200);
    nodes = await readScreen({ attempts: 4 });
  }
  if (!find(nodes, 'direct_tab')) throw new SessionError('could not get back to Instagram\'s main tabs');
  return nodes;
}

export { readScreen, raiseAlert, sleep, jitter };

/**
 * Un-save the post/reel that is open. On a saved item the bookmark opens the collections
 * sheet; the "Saved" row there ("Tap this row to unsave media") is what un-saves.
 */
async function unsaveOpenMedia() {
  const media = readOpenMedia(await readScreen());
  if (!media.saved || !media.saveNode) return false;
  await device.tapNode(media.saveNode, { allow: (n) => /^remove from saved$/i.test((n.desc || '').trim()) });
  await sleep(1500);
  let nodes = await readScreen();
  const row = nodes.find(n => /tap this row to unsave/i.test(n.desc));
  if (row) {
    await device.tapNode(row);
    await sleep(1200);
    nodes = await readScreen();
  }
  if (screenKind(nodes) === 'sheet') { await device.back(); await sleep(800); nodes = await readScreen(); }
  return !readOpenMedia(nodes).saved;
}

const SAVED_TILE_RE = /^(?:Reel|Photo|Video) by .+ at row (\d+), column (\d+)$/i;

/**
 * Open the saved reel by `account` from the Saved grid. Tiles only carry the display name,
 * so tiles are opened one by one (label matches first) and the account is read on the
 * opened item. The feed viewer shows no caption to tell two reels of one account apart,
 * so every tile tried is checked: a second item by the same account → refused (the wrong
 * reel would be sent and un-saved) rather than guessing. `io` is for tests.
 */
export async function openSavedReelBy(account, io = { readScreen, tapNode: (n) => device.tapNode(n), back: () => device.back(), sleep }) {
  const want = String(account).toLowerCase();
  const gridTiles = async () => {
    const nodes = await io.readScreen();
    const tiles = nodes.filter(n => n.clickable && n.bounds && SAVED_TILE_RE.test(n.desc))
      .sort((a, b) => a.bounds.y1 - b.bounds.y1 || a.bounds.x1 - b.bounds.x1);
    return [...tiles.filter(t => t.desc.toLowerCase().includes(want)), ...tiles.filter(t => !t.desc.toLowerCase().includes(want))];
  };
  const matches = [];
  for (let tried = 0; tried < 6; tried++) {
    const ordered = await gridTiles();
    if (!ordered.length) throw new SessionError('Saved list is empty');
    const tile = ordered[tried];
    if (!tile) break;
    await io.tapNode(tile);
    await io.sleep(2500);
    const opened = readOpenMedia(await io.readScreen());
    if (opened.account === account) matches.push(tried);
    await io.back(); // back to the Saved grid (inside Instagram)
    await io.sleep(1500);
    if (matches.length > 1) throw new SessionError(`more than one saved reel by ${account}: can't tell which one is queued — share it from the phone, or un-save the other one in Instagram`);
  }
  if (!matches.length) throw new SessionError(`saved reel by ${account} not found in the first saved items`);
  const tile = (await gridTiles())[matches[0]];
  if (!tile) throw new SessionError(`saved reel by ${account} moved in the Saved list`);
  await io.tapNode(tile);
  await io.sleep(2500);
  const opened = readOpenMedia(await io.readScreen());
  if (opened.account !== account) throw new SessionError(`saved reel by ${account} moved in the Saved list`);
  return opened;
}

export function vetoReel(reelId, actor) {
  const reel = store.getReel(reelId);
  if (!reel) throw new SessionError('reel not found', 404);
  store.updateReel(reelId, { share_state: 'vetoed', approved_by: actor });
  emit({ kind: 'queue' });
}

export function setShareCaption(reelId, caption) {
  const reel = store.getReel(reelId);
  if (!reel) throw new SessionError('reel not found', 404);
  store.updateReel(reelId, { share_caption: caption });
  emit({ kind: 'queue' });
}

// ── Browsing session ─────────────────────────────────────────────────────────

/**
 * Start a session in the background. trigger: 'auto' | 'manual'. Returns the session id.
 * allowShare: lets a manual session share strong reels straight into the group (an
 * automatic one does in 'auto' approval mode). Warmup and the daily share cap still
 * apply either way (inSessionShareGate); otherwise reels are saved to the queue.
 */
export function startSession({ trigger, minutes, allowShare = false, actor = null }) {
  if (!config.instagram.deviceSerial || !config.instagram.deviceModel) throw new SessionError('Instagram phone is not configured');
  if (alert) throw new SessionError(`paused: ${alert.text} — clear the alert on the dashboard first`);
  if (busy) throw new SessionError('a session or share is already running');
  const releaseLock = acquirePhoneLock(`${trigger} session`);
  if (!releaseLock) throw new SessionError(`the phone is in use by another process (${readPhoneLock()?.owner || 'unknown'})`);
  const lo = config.instagram.sessionMinMinutes;
  const hi = Math.max(lo, config.instagram.sessionMaxMinutes);
  const mins = Math.max(1, Math.min(30, minutes || jitter(lo, hi)));
  const id = store.createSession({ trigger, initiatedBy: actor, allowShare, plannedMin: Math.round(mins * 10) / 10 });
  busy = true;
  current = {
    id, trigger, allowShare, startedAt: Date.now(), plannedMs: mins * 60_000, stop: false, phase: 'starting', reel: null,
    counts: { seen: 0, liked: 0, queued: 0, shared: 0, cost: 0 }, releaseLock,
  };
  emit({ kind: 'session', state: instagramState() });
  runLoop(current).catch(() => {});
  return id;
}

export function stopSession() {
  if (!current) return false;
  current.stop = true;
  current.phase = 'stopping';
  emit({ kind: 'session', state: instagramState() });
  return true;
}

/**
 * Gemini Live watching the phone's screen + audio for the whole session. Returns null
 * (clip mode for this session) if Live can't start. If the stream ends because something
 * other than Instagram came to the front, the session aborts — device.js has already
 * dropped everything from that window.
 */
async function startLive(s) {
  const watcher = new LiveWatcher();
  try {
    await watcher.connect();
  } catch (err) {
    logger.warn({ err: err.message }, 'Gemini Live unavailable; this session uses clip mode');
    return null;
  }
  const live = { watcher, frames: [], stream: null };
  try {
    live.stream = await device.startScreenStream({
      onFrame: (jpeg) => { watcher.sendFrame(jpeg); live.frames.push(jpeg); if (live.frames.length > 15) live.frames.shift(); },
      onAudio: (pcm) => watcher.sendAudio(pcm),
      onEnd: (reason) => {
        if (reason === 'stopped' || s.stop) return;
        const foreign = /^foreground is (\S+)/.exec(reason)?.[1] || null;
        live.dead = true;
        if (/foreground|lock screen/.test(reason)) s.streamAbort = { reason, foreground: foreign };
        else logger.warn({ reason }, 'screen stream ended; continuing in clip mode');
      },
    });
  } catch (err) {
    watcher.close();
    if (err instanceof device.ForeignAppError) throw err;
    logger.warn({ err: err.message }, 'screen stream failed to start; this session uses clip mode');
    return null;
  }
  // Give the recorder a moment to start producing frames before the first reel.
  for (let i = 0; i < 20 && !live.frames.length; i++) await sleep(500);
  return live;
}

/** Live is usable: connected AND the screen stream is still feeding it. */
const liveOk = (s) => !!(s.live && !s.live.dead && s.live.watcher.ready);

async function runLoop(s) {
  let endReason = 'time up';
  try {
    s.phase = 'opening Instagram';
    await device.wake();
    await sleep(1500);
    // The bot never unlocks anything: a lock screen (even "Swipe") ends the session here.
    if ((await device.lockState()).locked) {
      raiseAlert('locked', 'The phone is showing its lock screen. Set Screen lock to None (not Swipe) on the phone.');
      throw new SessionError('phone is locked (Screen lock must be None, not Swipe)');
    }
    await device.launchInstagram({ launcherPackages: config.instagram.launcherPackages });
    await sleep(3000);
    try {
      await openReelsTab();
    } catch (err) {
      // Instagram is in front but its screen won't go "idle" (usually: a reel is already
      // playing). Carry on; the loop re-navigates as soon as a read succeeds.
      if (!(err instanceof device.DeviceError) || err instanceof device.ForeignAppError) throw err;
      logger.info({ err: err.message }, 'could not confirm the Reels tab at start; continuing');
    }
    await sleep(1500);
    if (config.instagram.watchMode === 'live') s.live = await startLive(s);

    const taste = tasteForJudge();
    let lastKey = null;
    let unreadable = 0;
    let sameCount = 0;
    while (!s.stop && Date.now() - s.startedAt < s.plannedMs) {
      if (s.streamAbort) throw new device.ForeignAppError(s.streamAbort.foreground);
      s.phase = 'reading';
      let nodes;
      try {
        nodes = await readScreen();
      } catch (err) {
        if (err instanceof SessionError || err instanceof device.ForeignAppError || !(err instanceof device.DeviceError)) throw err;
        // Can't read the screen (uiautomator never saw it idle). Still log the reel from a
        // screenshot, but don't like/save: without the dump we can't see the buttons.
        if (++unreadable >= 6) throw new SessionError('screen unreadable 6 times in a row');
        if (liveOk(s)) await handleReel(s, { unreadable: true }, tasteForJudge()); // Live still sees and hears it
        else await handleUnreadableReel(s);
        lastKey = null;
        await swipeNext();
        continue;
      }
      unreadable = 0;
      if (screenKind(nodes) === 'sheet') { await device.back(); await sleep(1200); continue; }
      if (screenKind(nodes) !== 'reels') {
        try { await openReelsTab(); } catch (err) { if (!(err instanceof device.DeviceError) || err instanceof device.ForeignAppError) throw err; await swipeNext(); }
        continue;
      }
      const onScreen = readReel(nodes);
      const key = reelKey(onScreen);
      if (key === lastKey) {
        // The swipe didn't move us on: something (an Instagram sheet) is in the way.
        if (++sameCount >= 6) throw new SessionError('stuck on the same reel');
        if (sameCount === 3) { await device.back(); await sleep(1200); await openReelsTab(); continue; }
        await swipeNext();
        continue;
      }
      sameCount = 0;
      lastKey = key;
      await handleReel(s, onScreen, taste);
      if (s.stop) break;
      s.phase = 'scrolling';
      await swipeNext();
    }
    if (s.stop) endReason = 'stopped';
    // The phone is awake and in Instagram anyway: look at the group chat on the way out.
    if (!s.stop && isSkillEnabled('instagram-chat')) {
      s.phase = 'checking the group chat';
      if (s.live) { s.counts.liveTokens = s.live.watcher.usage.prompt; s.live.stream?.stop(); s.live.watcher.close(); s.live = null; }
      await checkChatInner({ trigger: 'after session' }).catch(err => logger.warn({ err: err.message }, 'after-session chat check failed'));
    }
  } catch (err) {
    endReason = err instanceof device.ForeignAppError
      ? (err.foreground ? `another app came to the front (${err.foreground})` : err.message)
      : err.message;
    if (err instanceof device.ForeignAppError) raiseAlert('foreign_app', endReason);
    logger.warn({ err: err.message, session: s.id }, 'Instagram session ended early');
  } finally {
    if (s.live) {
      s.counts.liveTokens = s.live.watcher.usage.prompt;
      s.live.stream?.stop();
      s.live.watcher.close();
    }
    if (s.streamAbort && !/another app|lock screen/.test(endReason)) endReason = s.streamAbort.reason;
    store.endSession(s.id, endReason, s.counts);
    current = null;
    busy = false;
    s.releaseLock?.();
    device.sleep().catch(() => {});
    emit({ kind: 'session', state: instagramState(), ended: { id: s.id, reason: endReason, counts: s.counts } });
    logger.info({ session: s.id, reason: endReason, ...s.counts }, 'Instagram session finished');
  }
}

async function handleUnreadableReel(s) {
  s.phase = 'describing (screenshot only)';
  s.counts.seen++;
  const started = Date.now();
  const row = { session_id: s.id, action: 'skip', reason: 'screen unreadable: logged from a screenshot, no like/save', cost_usd: 0 };
  let thumb = null;
  try {
    const png = await device.screenshot();
    thumb = await thumbnailFromPng(png).catch(() => null);
    const quick = await describeFrame(png, {});
    Object.assign(row, {
      account: quick.account_on_screen?.replace(/^@/, '').slice(0, 60) || null,
      description: descriptionText(quick), description_depth: 'quick', language: quick.language, humour_type: quick.humour_type,
      ...(quick.is_ad ? { reason: 'ad (screen unreadable: logged from a screenshot)' } : {}),
    });
  } catch (err) {
    if (err instanceof device.ForeignAppError) throw err;
    row.reason = `screen unreadable; screenshot failed: ${err.message.slice(0, 120)}`;
  }
  row.dwell_ms = Date.now() - started;
  row.id = store.insertReel(row);
  if (thumb) store.updateReel(row.id, { thumb_path: await saveThumb(row.id, thumb) });
  s.reel = { id: row.id, account: row.account, action: 'skip', reason: row.reason, description: row.description };
  emit({ kind: 'reel', session: s.id, reel: s.reel, counts: s.counts });
}

async function handleReel(s, onScreen, taste) {
  const started = Date.now();
  const meta = {
    account: onScreen.account,
    caption: onScreen.caption ? sanitizeWebContent(onScreen.caption).slice(0, 500) : null,
  };
  s.reel = { account: meta.account, caption: meta.caption, step: 'looking' };
  s.counts.seen++;
  emit({ kind: 'reel', session: s.id, reel: s.reel, counts: s.counts });

  const row = { session_id: s.id, account: meta.account, caption: meta.caption, like_count: onScreen.likeCount, cost_usd: 0 };
  let thumb = null;
  try {
    // First look → Jev "worth watching?" → (if so) keep watching → full look → full judgment.
    // Live mode: Gemini Live is already watching the stream; ask after ~3 s like a person
    // would decide. Clip mode / Live unavailable: one screenshot, then a recorded clip.
    const landed = started;
    let first = null;
    if (liveOk(s)) {
      s.phase = 'watching (first look)';
      s.live.watcher.newReel(meta);
      await sleep(Math.max(0, config.instagram.firstLookSeconds * 1000 - (Date.now() - landed)));
      first = await s.live.watcher.report('first_look').catch((err) => {
        logger.warn({ err: err.message }, 'live first look failed; falling back to a screenshot');
        return null;
      });
      if (first) {
        thumb = s.live.frames.at(-1) || null;
        Object.assign(row, { description: descriptionText(first), description_depth: 'first_look', language: first.language, humour_type: first.humour_type });
      }
    }
    if (!first) {
      s.phase = 'describing';
      const png = await device.screenshot();
      thumb = await thumbnailFromPng(png).catch(() => null);
      first = await describeFrame(png, meta);
      Object.assign(row, { description: descriptionText(first), description_depth: 'quick', language: first.language, humour_type: first.humour_type });
    }
    if (!row.account && first.account_on_screen) row.account = meta.account = first.account_on_screen.replace(/^@/, '').slice(0, 60);
    s.reel.account = row.account;

    if (onScreen.isAd || first.is_ad) {
      Object.assign(row, { action: 'skip', reason: 'ad' });
    } else {
      s.phase = 'judging';
      const q = await judgeQuick({ ...meta, description: row.description }, taste);
      row.cost_usd += q.cost || 0;
      Object.assign(row, { jev_model: q.model, jev_answers: { quick: q.answers }, hazards: q.hazards });
      if (!q.watch) {
        Object.assign(row, { action: 'skip', reason: q.hazards.length ? `hazard: ${q.hazards.map(h => h.hazard).join(', ')}` : 'not worth watching' });
      } else {
        // Keep watching, describe properly, judge properly.
        s.phase = 'watching';
        s.reel.step = 'watching';
        emit({ kind: 'reel', session: s.id, reel: s.reel, counts: s.counts });
        let full = null;
        let frames = [];
        if (liveOk(s) && row.description_depth === 'first_look') {
          s.live.watcher.continueWatching();
          await sleep(Math.max(0, config.instagram.fullLookSeconds * 1000 - (Date.now() - landed)));
          full = await s.live.watcher.report('full').catch((err) => {
            logger.warn({ err: err.message }, 'live full look failed; using the first look');
            return null;
          });
          frames = s.live.frames.slice(-3);
          if (full) Object.assign(row, { description: descriptionText(full), description_depth: 'full_live', language: full.language, humour_type: full.humour_type });
        } else {
          const clip = await device.recordClip(config.instagram.clipSeconds);
          s.phase = 'describing';
          full = await describeClip(clip, meta);
          frames = await extractFrames(clip, 3, 360, config.instagram.clipSeconds).catch(() => []);
          if (frames[0]) thumb = frames[0];
          Object.assign(row, { description: descriptionText(full), description_depth: 'full', language: full.language, humour_type: full.humour_type });
        }
        s.phase = 'judging';
        const j = await judgeFull({ ...meta, description: row.description }, taste, [],
          { frames: config.instagram.framesToJev ? frames : [] });
        row.cost_usd += j.cost || 0;
        Object.assign(row, {
          jev_model: j.model, jev_answers: { ...row.jev_answers, full: j.answers }, humour: j.humour, fit: j.fit,
          confidence: j.confidence, hazards: j.hazards, for_whom: j.forWhom, action: j.action, reason: j.reason,
        });
      }
    }

    // Act. The reel may have moved on while we were thinking — only act on the same reel.
    if (row.action !== 'skip' && onScreen.unreadable) {
      row.reason = `${row.reason}; screen unreadable, so no like/save`;
    } else if (row.action !== 'skip') {
      s.phase = 'acting';
      const nodes = await readScreen();
      const now = readReel(nodes);
      if (reelKey(now) === reelKey(onScreen) || now.account === onScreen.account) {
        const { liked: likedToday } = dailyCounts();
        if (!now.liked && now.likeNode && likedToday < config.instagram.likesPerDay) {
          await sleep(jitter(400, 1200));
          await device.tapNode(now.likeNode);
          row.liked = true;
          s.counts.liked++;
        }
        if (row.action === 'like_and_queue') {
          row.queued = true;
          s.counts.queued++;
          if (inSessionShareGate({ allowShare: s.allowShare }).share) {
            row.share_state = 'approved';
            const id = store.insertReel(row);
            row.id = id;
            store.updateReel(id, { thumb_path: await saveThumb(id, thumb) });
            s.phase = 'sharing';
            const res = await shareReelRow({ ...row, share_caption: null }, { actor: s.trigger === 'manual' ? 'manual session' : 'auto' })
              .catch(err => { logger.warn({ err: err.message }, 'in-session share failed'); return { sent: false }; });
            if (res.sent) s.counts.shared++;
          } else if (now.saveNode && !now.saved) {
            await sleep(jitter(300, 900));
            await device.tapNode(now.saveNode);
            row.saved = true;
            row.share_state = 'queued';
            // The first Save opens a "Collect the posts you love" sheet; close it (BACK).
            await sleep(1500);
            if (screenKind(await readScreen()) === 'sheet') { await device.back(); await sleep(800); }
          } else {
            row.share_state = 'queued';
          }
        }
      } else {
        row.reason = `${row.reason}; reel moved on before acting`;
      }
    }
  } catch (err) {
    if (err instanceof SessionError || err instanceof device.ForeignAppError) { await finishRow(); throw err; }
    row.reason = `error: ${err.message.slice(0, 200)}`;
    row.action = row.action || 'skip';
  }
  await finishRow();

  async function finishRow() {
    row.dwell_ms = Date.now() - started;
    s.counts.cost += row.cost_usd;
    if (!row.action) row.action = 'skip';
    if (row.id) {
      const { id, ...rest } = row;
      store.updateReel(id, { action: rest.action, reason: rest.reason, liked: rest.liked, dwell_ms: rest.dwell_ms });
    } else {
      row.id = store.insertReel(row);
      if (thumb) store.updateReel(row.id, { thumb_path: await saveThumb(row.id, thumb) });
    }
    s.reel = { id: row.id, account: row.account, action: row.action, reason: row.reason, description: row.description };
    emit({ kind: 'reel', session: s.id, reel: s.reel, counts: s.counts });
  }
}
