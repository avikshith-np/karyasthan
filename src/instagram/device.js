import { execFile, execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// The ONLY door to the Instagram phone (specs/005 "Device guard").
//
// Hard rule from the owner: ADB may control com.instagram.android and nothing else.
// Android can't restrict ADB to one app, so this module enforces it:
//   - Named operations only. There is deliberately no exported shell(cmd).
//   - Every input and capture first checks that Instagram is in front; a capture is
//     re-checked afterwards and discarded if the foreground changed. A foreign app
//     throws ForeignAppError — we never press BACK/HOME or tap to "get back".
//   - Every intent is package-scoped to Instagram; URLs are allow-listed.
//   - Every command is pinned with `adb -s <id>` to the configured phone. Resolution
//     reads only `adb devices -l` and never sends a command to a device whose listed
//     model doesn't match, so the call-gateway phone (also on ADB) is never touched.
//   - Every command is logged (ring buffer + listeners → ig_device_log).
// The few non-Instagram commands (wake/sleep, battery, getprop, reading the focused
// window) observe or power the device; none opens or controls an app.

export const IG_PACKAGE = 'com.instagram.android';
const IG_LAUNCH_COMPONENT = `${IG_PACKAGE}/.activity.MainTabActivity`;

const IG_URL_RE = /^https:\/\/www\.instagram\.com\/(?:reels?|p|direct\/t)\/[A-Za-z0-9_-]+\/?(?:\?[A-Za-z0-9_=&-]*)?$/;
const REMOTE_TMP = '/data/local/tmp/karyasthan';
const LOG_MAX = 500;
const RESOLVE_TTL_MS = 60_000;

export class DeviceError extends Error {}
export class ForeignAppError extends DeviceError {
  constructor(pkg) {
    super(pkg
      ? `foreground is ${pkg}, not Instagram`
      : 'the lock screen or notification shade is in front (set Screen lock to None on the phone)');
    this.foreground = pkg || null;
  }
}

const events = new EventEmitter();
const commandLog = [];
let resolved = null; // { id, at }

// Injectable for scripts/test-instagram.js: (argv[], { binary }) → Promise<Buffer>.
let runner = (argv, { timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
  execFile(config.instagram.adbPath, argv, { encoding: 'buffer', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message.trim()} ${stderr?.toString().trim() || ''}`.trim();
        reject(err);
      } else resolve(stdout);
    });
});

export function _setRunner(fn) { runner = fn; resolved = null; }
export function _resetForTests() { resolved = null; commandLog.length = 0; }

export function onDeviceCommand(fn) {
  events.on('command', fn);
  return () => events.off('command', fn);
}

export function recentCommands(limit = 100) {
  return commandLog.slice(-limit).reverse();
}

function record(entry) {
  commandLog.push(entry);
  if (commandLog.length > LOG_MAX) commandLog.shift();
  events.emit('command', entry);
}

// ── Device resolution ────────────────────────────────────────────────────────

export function parseDevicesList(text) {
  return text.split('\n').slice(1).map(line => line.trim()).filter(Boolean).map(line => {
    const [id, state, ...rest] = line.split(/\s+/);
    const props = Object.fromEntries(rest.filter(t => t.includes(':')).map(t => {
      const i = t.indexOf(':');
      return [t.slice(0, i), t.slice(i + 1)];
    }));
    return { id, state, model: props.model || null, product: props.product || null };
  });
}

async function resolveDeviceId() {
  if (resolved && Date.now() - resolved.at < RESOLVE_TTL_MS) return resolved.id;
  const { deviceSerial: serial, deviceModel: model } = config.instagram;
  if (!serial || !model) throw new DeviceError('IG_DEVICE_SERIAL and IG_DEVICE_MODEL must both be set');

  // Server-level query: lists devices without sending anything to them.
  const list = parseDevicesList((await runner(['devices', '-l'])).toString());
  const candidates = list.filter(d => d.state === 'device' && d.model === model
    && (d.id === serial || d.id.startsWith(`adb-${serial}-`) || /^[\d.]+:\d+$/.test(d.id)));
  for (const d of candidates) {
    // Only model-matched devices get this read-only check.
    const sn = (await runner(['-s', d.id, 'shell', 'getprop', 'ro.serialno'])).toString().trim();
    if (sn === serial) {
      resolved = { id: d.id, at: Date.now() };
      return d.id;
    }
  }
  // Paired phones reconnect on their own over mDNS once Wireless debugging is on; Android
  // turns it off after Wi-Fi changes and reboots.
  throw new DeviceError(`Instagram phone (serial ${serial}, model ${model}) is not connected: turn on Wireless debugging on the phone`);
}

async function adb(op, args, opts = {}) {
  const started = Date.now();
  const entry = { ts: started, op, args: opts.logArgs ?? args.join(' '), foreground: opts.foreground ?? null, ok: false, ms: 0, error: null };
  try {
    const id = await resolveDeviceId();
    const out = await runner(['-s', id, ...args], opts);
    // Some tools exit 0 on failure (uiautomator prints "ERROR: …"); let the caller say.
    const problem = opts.validate?.(out);
    if (problem) throw new DeviceError(problem);
    entry.ok = true;
    return out;
  } catch (err) {
    entry.error = err.message;
    if (!(err instanceof DeviceError)) resolved = null; // re-resolve after transport errors
    throw err;
  } finally {
    entry.ms = Date.now() - started;
    // The live stream's once-a-second gate checks are logged only when they fail.
    if (!(opts.quiet && entry.ok)) record(entry);
  }
}

// ── Observation (no app control) ─────────────────────────────────────────────

function parseFocus(text) {
  const pick = (key) => {
    const m = text.match(new RegExp(`${key}=[^\\n]*?\\s([A-Za-z0-9_.]+)/[^\\s}]+`));
    return m ? m[1] : null;
  };
  // mCurrentFocus is the window with input focus (includes system overlays such as the
  // notification shade, which show up as a window with no package/activity → null).
  return { current: pick('mCurrentFocus'), focusedApp: pick('mFocusedApp') };
}

/** Package that has input focus right now, or null (system overlay / transition). */
export async function foreground({ quiet = false } = {}) {
  const out = await adb('foreground', ['shell', "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"], { quiet });
  return parseFocus(out.toString()).current;
}

/** Screen/lock state from the window manager (observation only, like foreground()). */
export async function lockState() {
  const out = (await adb('lockState', ['shell', "dumpsys window | grep -E 'isKeyguardShowing|mAwake='"])).toString();
  return {
    locked: /isKeyguardShowing=true/.test(out),
    awake: /mAwake=true/.test(out),
  };
}

async function requireInstagram(op) {
  // Focus is briefly null during animations; re-check a couple of times before refusing.
  for (let i = 0; i < 3; i++) {
    const pkg = await foreground();
    if (pkg === IG_PACKAGE) return;
    if (pkg) {
      record({ ts: Date.now(), op: `${op}:refused`, args: '', foreground: pkg, ok: false, ms: 0, error: 'foreign app in front' });
      throw new ForeignAppError(pkg);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new ForeignAppError(null);
}

export async function deviceInfo() {
  const out = (await adb('deviceInfo', ['shell', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk'])).toString();
  const [model, android, sdk] = out.split('\n').map(l => l.trim());
  return { model, android, sdk: parseInt(sdk, 10) || null };
}

export async function battery() {
  const out = (await adb('battery', ['shell', 'dumpsys', 'battery'])).toString();
  const num = (k) => { const m = out.match(new RegExp(`^\\s*${k}: (\\d+)`, 'm')); return m ? parseInt(m[1], 10) : null; };
  const temp = num('temperature');
  return { level: num('level'), tempC: temp == null ? null : temp / 10, plugged: (num('AC powered') || 0) + (num('USB powered') || 0) > 0 || /powered: true/.test(out) };
}

export async function wake() { await adb('wake', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); }
export async function sleep() { await adb('sleep', ['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']); }

// ── Instagram control ────────────────────────────────────────────────────────

/**
 * Bring Instagram to the front. Allowed only over Instagram itself or the home screen.
 * No focused app (null) means the lock screen / notification shade — refused: launching
 * from there would be acting on the lock screen.
 */
export async function launchInstagram({ launcherPackages = [] } = {}) {
  let fg = await foreground();
  if (!fg) { await new Promise(r => setTimeout(r, 800)); fg = await foreground(); } // focus can be briefly null right after wake
  if (fg !== IG_PACKAGE && !launcherPackages.includes(fg)) throw new ForeignAppError(fg);
  // Instagram's launcher entry doesn't resolve from a package-scoped MAIN/LAUNCHER intent,
  // so name the component explicitly (still Instagram-only by construction).
  await adb('launchInstagram', ['shell', 'am', 'start', '-W', '-n', IG_LAUNCH_COMPONENT], { foreground: fg });
}

/** Open an instagram.com link inside the Instagram app (never a browser). */
export async function openInstagramUrl(url) {
  if (typeof url !== 'string' || !IG_URL_RE.test(url)) throw new DeviceError(`not an allowed Instagram URL: ${url}`);
  await requireInstagram('openInstagramUrl');
  await adb('openInstagramUrl', ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
    '-d', `'${url}'`, '-p', IG_PACKAGE], { foreground: IG_PACKAGE });
}

const int = (v, name) => {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new DeviceError(`bad ${name}: ${v}`);
  return String(v);
};

export async function tap(x, y) {
  await requireInstagram('tap');
  await adb('tap', ['shell', 'input', 'tap', int(x, 'x'), int(y, 'y')], { foreground: IG_PACKAGE });
}

// Instagram buttons that hand off to ANOTHER app (the share sheet's WhatsApp / system
// Share / Download / Add to story row, cross-posting to Meta apps, open-in-browser).
// Session code taps through tapNode(), which refuses these outright; the foreground
// check after a tap is only the backstop.
const LEAVES_INSTAGRAM_RE = /whatsapp|facebook|messenger|threads|browser|download|add to story|sms|gmail|telegram|snapchat|x \(twitter\)/i;

// Instagram buttons that stay in Instagram but must never be pressed by the bot: calls,
// group-admin tools (remove/make admin), follow/add/requests, camera/gallery (the gallery
// opens Android's photo picker), voice recording, block/report/leave.
const NEVER_TAP_RE = /audio call|video call|^call$|more options for|add people|^add$|follow all|^follow\b|requests|camera|gallery|voice message|block|report|leave (?:chat|group)|remove|delete|unsend|mute|make admin/i;

function neverTap(node) {
  const label = `${node.desc || ''} ${node.text || ''}`.trim();
  return !!label && NEVER_TAP_RE.test(label);
}

function leavesInstagram(node) {
  const label = `${node.desc || ''} ${node.text || ''}`;
  if (LEAVES_INSTAGRAM_RE.test(label)) return true;
  // The share sheet's bottom row uses the generic id ":id/button"; its "Share" is the
  // Android system chooser (Instagram's own Share is #direct_share_button).
  return node.id === `${IG_PACKAGE}:id/button` && /^share$/i.test((node.desc || node.text || '').trim());
}

/** Tap the centre of a node from dumpScreen(), unless it would hand off to another app. */
export async function tapNode(node, { allow } = {}) {
  if (!node?.bounds) throw new DeviceError('tapNode: node has no bounds');
  if (node.pkg && node.pkg !== IG_PACKAGE) throw new ForeignAppError(node.pkg);
  if (leavesInstagram(node)) {
    record({ ts: Date.now(), op: 'tapNode:refused', args: node.desc || node.text, foreground: IG_PACKAGE, ok: false, ms: 0, error: 'leaves Instagram' });
    throw new DeviceError(`refusing to tap "${node.desc || node.text}": it opens another app`);
  }
  if (neverTap(node) && !allow?.(node)) {
    record({ ts: Date.now(), op: 'tapNode:refused', args: node.desc || node.text, foreground: IG_PACKAGE, ok: false, ms: 0, error: 'never-tap button' });
    throw new DeviceError(`refusing to tap "${node.desc || node.text}": the bot never presses that`);
  }
  const { x1, y1, x2, y2 } = node.bounds;
  await tap(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
}

export async function swipe(x1, y1, x2, y2, durationMs = 300) {
  await requireInstagram('swipe');
  await adb('swipe', ['shell', 'input', 'swipe', int(x1, 'x1'), int(y1, 'y1'), int(x2, 'x2'), int(y2, 'y2'),
    int(durationMs, 'duration')], { foreground: IG_PACKAGE });
}

/** Delete `count` characters in the focused Instagram field (KEYCODE_DEL). */
export async function deleteChars(count) {
  const n = Math.max(1, Math.min(200, Math.round(count)));
  await requireInstagram('deleteChars');
  await adb('deleteChars', ['shell', 'input', 'keyevent', ...Array(n).fill('KEYCODE_DEL')], { foreground: IG_PACKAGE, logArgs: `${n}×DEL` });
}

/** Double-tap (Instagram: heart a DM message / like a reel). */
export async function doubleTap(x, y) {
  await requireInstagram('doubleTap');
  const xs = int(x, 'x');
  const ys = int(y, 'y');
  await adb('doubleTap', ['shell', `input tap ${xs} ${ys} && input tap ${xs} ${ys}`], { foreground: IG_PACKAGE });
}

/** BACK inside Instagram only (closing an Instagram sheet/dialog). */
export async function back() {
  await requireInstagram('back');
  await adb('back', ['shell', 'input', 'keyevent', 'KEYCODE_BACK'], { foreground: IG_PACKAGE });
}

/**
 * Type into the focused Instagram field. `input text` can't type emoji or non-Latin
 * script, so only printable ASCII is accepted; callers strip the rest.
 */
export async function typeText(text) {
  if (typeof text !== 'string' || !text || text.length > 500 || !/^[\x20-\x7E]+$/.test(text)) {
    throw new DeviceError('typeText accepts 1–500 printable ASCII characters');
  }
  await requireInstagram('typeText');
  // `input text` turns %s into a space; everything else is literal once single-quoted.
  const arg = `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`;
  await adb('typeText', ['shell', 'input', 'text', arg], { foreground: IG_PACKAGE, logArgs: `(${text.length} chars)` });
}

// ── Capture ──────────────────────────────────────────────────────────────────

function parseUiDump(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
    const b = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({
      text: attrs.text || '', desc: attrs['content-desc'] || '', id: attrs['resource-id'] || '',
      cls: attrs.class || '', pkg: attrs.package || '', clickable: attrs.clickable === 'true',
      selected: attrs.selected === 'true',
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
  }
  return nodes;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
}

/** Accessibility dump of the Instagram window. Refuses if any node belongs to another app. */
export async function dumpScreen({ attempts = 4 } = {}) {
  // uiautomator reports "could not get idle state" (after ~12 s) while something keeps
  // animating — a story ring, some reels. Often fine a moment later; sessions pass a
  // lower `attempts` and fall back to a screenshot instead of waiting.
  let out = '';
  let start = -1;
  for (let attempt = 0; attempt < attempts && start < 0; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 600 * attempt));
    await requireInstagram('dumpScreen');
    try {
      out = (await adb('dumpScreen', ['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
        foreground: IG_PACKAGE, timeoutMs: 30_000,
        validate: (buf) => (buf.includes('<?xml') ? null : `uiautomator dump failed: ${buf.toString().trim().slice(0, 120)}`),
      })).toString();
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err;
      out = err.message;
    }
    start = out.indexOf('<?xml');
  }
  if (start < 0) throw new DeviceError(out.startsWith('uiautomator dump failed') ? out : `uiautomator dump failed: ${out.trim().slice(0, 200)}`);
  const xml = out.slice(start, out.lastIndexOf('</hierarchy>') + '</hierarchy>'.length);
  const nodes = parseUiDump(xml);
  const foreign = nodes.find(n => n.pkg && n.pkg !== IG_PACKAGE);
  if (foreign) throw new ForeignAppError(foreign.pkg);
  return { xml, nodes };
}

/** PNG of the screen, only while Instagram is in front before and after. */
export async function screenshot() {
  await requireInstagram('screenshot');
  const png = await adb('screenshot', ['exec-out', 'screencap', '-p'], { foreground: IG_PACKAGE, logArgs: '' });
  await requireInstagram('screenshot:after');
  return png;
}

/** MP4 (video only) of the next `seconds` seconds; discarded if Instagram left the front. */
export async function recordScreen(seconds = 15) {
  const secs = Math.max(1, Math.min(60, Math.round(seconds)));
  await requireInstagram('recordScreen');
  const file = `${REMOTE_TMP}/rec.mp4`;
  await adb('recordScreen', ['shell', `mkdir -p ${REMOTE_TMP} && screenrecord --time-limit ${secs} --size 720x1600 --bit-rate 2000000 ${file}`],
    { foreground: IG_PACKAGE, timeoutMs: (secs + 15) * 1000 });
  try {
    await requireInstagram('recordScreen:after');
    return await adb('recordScreen:pull', ['exec-out', 'cat', file], { foreground: IG_PACKAGE, timeoutMs: 30_000 });
  } finally {
    await adb('recordScreen:cleanup', ['shell', 'rm', '-f', file]).catch(() => {});
  }
}

// scrcpy runner: (argv[], { timeoutMs }) → Promise<void>.
const scrcpyRunner = (argv, { timeoutMs }) => new Promise((resolve, reject) => {
  execFile(config.instagram.scrcpyPath, argv, {
    timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    // Use OUR adb so scrcpy doesn't restart the adb server with its bundled version.
    env: { ...process.env, ADB: config.instagram.adbPath },
  }, (err, _stdout, stderr) => {
    if (err) { err.message = `${err.message.trim()} ${stderr?.toString().trim().slice(-300) || ''}`.trim(); reject(err); } else resolve();
  });
});

/**
 * MP4 (H.264 + AAC, with the phone's audio output) of the next `seconds` seconds,
 * recorded by scrcpy as a pure recorder: --no-control means it never injects input or
 * touches the clipboard. Discarded if Instagram wasn't in front before AND after.
 * While recording, the phone's own speaker is muted (scrcpy's "output" source).
 */
export async function recordClip(seconds = 15) {
  const secs = Math.max(2, Math.min(60, Math.round(seconds)));
  await requireInstagram('recordClip');
  const id = await resolveDeviceId();
  const file = path.join(os.tmpdir(), `kst-ig-${process.pid}-${Date.now()}.mp4`);
  const argv = ['-s', id, '--no-control', '--no-window', '--no-audio-playback', '--no-power-on',
    '--no-clipboard-autosync', '--max-size=720', '--max-fps=15', '--video-bit-rate=1M',
    '--video-codec=h264', '--audio-codec=aac', '--audio-source=output', `--time-limit=${secs}`, `--record=${file}`];
  const started = Date.now();
  const entry = { ts: started, op: 'recordClip', args: `scrcpy --no-control ${secs}s`, foreground: IG_PACKAGE, ok: false, ms: 0, error: null };
  try {
    await scrcpyRunner(argv, { timeoutMs: (secs + 20) * 1000 });
    entry.ok = true;
  } catch (err) {
    entry.error = err.message;
    throw err;
  } finally {
    entry.ms = Date.now() - started;
    record(entry);
  }
  try {
    await requireInstagram('recordClip:after');
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Live screen + audio stream for watching reels in real time (Gemini Live). scrcpy runs as
 * a pure recorder (--no-control) into a named pipe; ffmpeg turns it into 1 JPEG frame per
 * second and 16 kHz mono PCM.
 *
 * The Instagram-only rule, continuously: media is HELD BACK and released to the caller
 * only once a foreground check taken AFTER it was captured confirms Instagram was still
 * in front. The check runs every ~1 s; the first non-Instagram answer (another app, the
 * lock screen, the shade) kills the stream and drops everything still held, so nothing
 * from that window ever leaves this module. Returns { stop(), done } — `done` resolves
 * with the end reason.
 *
 * Callbacks: onFrame(jpegBuffer, ts), onAudio(pcmBuffer, ts).
 */
export async function startScreenStream({ onFrame, onAudio, frameWidth = 540, onEnd } = {}) {
  await requireInstagram('startScreenStream');
  const id = await resolveDeviceId();
  const fifo = path.join(os.tmpdir(), `kst-ig-stream-${process.pid}-${Date.now()}.mkv`);
  execFileSync('mkfifo', [fifo]);
  const startedAt = Date.now();
  record({ ts: startedAt, op: 'startScreenStream', args: 'scrcpy --no-control → 1 fps + 16 kHz', foreground: IG_PACKAGE, ok: true, ms: 0, error: null });

  const held = [];        // [{ kind, buf, ts }] captured but not yet cleared
  let clearedUntil = 0;   // media captured before this ts is confirmed Instagram-only
  let ended = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  const scrcpy = spawn(config.instagram.scrcpyPath, ['-s', id, '--no-control', '--no-window', '--no-audio-playback',
    '--no-power-on', '--no-clipboard-autosync', '--max-size=720', '--max-fps=15', '--video-bit-rate=1M',
    '--video-codec=h264', '--audio-codec=aac', '--audio-source=output', '--record-format=mkv', `--record=${fifo}`],
  { env: { ...process.env, ADB: config.instagram.adbPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  const ff = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', fifo,
    '-map', '0:v', '-vf', `fps=1,scale=${frameWidth}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1',
    '-map', '0:a', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:3'],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });

  // Split the MJPEG byte stream into frames.
  let jpg = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    jpg = Buffer.concat([jpg, chunk]);
    for (;;) {
      const s0 = jpg.indexOf(Buffer.from([0xff, 0xd8]));
      if (s0 < 0) { jpg = Buffer.alloc(0); break; }
      const e0 = jpg.indexOf(Buffer.from([0xff, 0xd9]), s0 + 2);
      if (e0 < 0) { jpg = jpg.subarray(s0); break; }
      held.push({ kind: 'frame', buf: jpg.subarray(s0, e0 + 2), ts: Date.now() });
      jpg = jpg.subarray(e0 + 2);
    }
  });
  ff.stdio[3].on('data', (chunk) => held.push({ kind: 'audio', buf: chunk, ts: Date.now() }));

  const release = () => {
    while (held.length && held[0].ts < clearedUntil) {
      const m = held.shift();
      try { (m.kind === 'frame' ? onFrame : onAudio)?.(m.buf, m.ts); } catch (err) { logger.warn({ err: err.message }, 'stream consumer threw'); }
    }
  };

  const end = (reason) => {
    if (ended) return;
    ended = true;
    clearInterval(gate);
    held.length = 0; // anything not yet confirmed is dropped, never released
    try { scrcpy.kill('SIGINT'); } catch {}
    try { ff.kill('SIGKILL'); } catch {}
    setTimeout(() => { try { scrcpy.kill('SIGKILL'); } catch {} fs.rmSync(fifo, { force: true }); }, 3000);
    record({ ts: Date.now(), op: 'stopScreenStream', args: reason, foreground: null, ok: true, ms: Date.now() - startedAt, error: null });
    try { onEnd?.(reason); } catch {}
    resolveDone(reason);
  };

  let checking = false;
  const gate = setInterval(async () => {
    if (ended || checking) return;
    checking = true;
    const checkStartedAt = Date.now();
    try {
      const pkg = await foreground({ quiet: true });
      if (pkg === IG_PACKAGE) { clearedUntil = checkStartedAt; release(); }
      else end(pkg ? `foreground is ${pkg}` : 'lock screen / shade in front');
    } catch (err) {
      end(`foreground check failed: ${err.message}`);
    } finally { checking = false; }
  }, 1000);

  scrcpy.on('exit', (code) => end(`scrcpy exited (${code})`));
  ff.on('exit', (code) => end(`ffmpeg exited (${code})`));
  let scrcpyErr = '';
  let ffErr = '';
  scrcpy.stderr.on('data', (d) => { scrcpyErr = (scrcpyErr + d).slice(-800); });
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-800); });
  done.then(() => { if (scrcpyErr || ffErr) logger.debug({ scrcpyErr, ffErr }, 'screen stream stderr'); });

  return { stop: () => end('stopped'), done };
}

/** Connection check for the dashboard device card; never throws. Cached 20 s. */
let statusCache = null;
export async function status() {
  if (statusCache && Date.now() - statusCache.at < 20_000) return statusCache.value;
  let value;
  try {
    const [info, bat, fg, lock] = [await deviceInfo(), await battery(), await foreground(), await lockState()];
    value = { connected: true, ...info, battery: bat, foreground: fg, instagramInFront: fg === IG_PACKAGE, locked: lock.locked };
  } catch (err) {
    logger.debug({ err: err.message }, 'instagram device status failed');
    value = { connected: false, error: err.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
}
