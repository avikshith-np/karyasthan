// Phase 0 probe for the Instagram phone (specs/005). Every operation goes through
// src/instagram/device.js, so the Instagram-only guard applies here too.
//
// Usage:
//   node scripts/ig-probe.js status
//   node scripts/ig-probe.js launch
//   node scripts/ig-probe.js dump [--all]          # Instagram nodes with text/desc/id
//   node scripts/ig-probe.js screenshot <out.png>
//   node scripts/ig-probe.js record <secs> <out.mp4>   # screenrecord (absent on OxygenOS 12)
//   node scripts/ig-probe.js clip <secs> <out.mp4>     # scrcpy, with audio
//   node scripts/ig-probe.js wake | sleep
//   node scripts/ig-probe.js tap <x> <y>
//   node scripts/ig-probe.js swipe <x1> <y1> <x2> <y2> [ms]
//   node scripts/ig-probe.js back
//   node scripts/ig-probe.js open <instagram-url>
//
// IG_PROBE_LOG=1 prints the commands this run sent (the bot's persistent device log is on
// the dashboard's Instagram page).

import fs from 'fs';

const device = await import('../src/instagram/device.js');
const { config } = await import('../src/utils/config.js');

const { acquirePhoneLock, readPhoneLock } = await import('../src/instagram/phoneLock.js');

const [op, ...args] = process.argv.slice(2);
// Anything that drives the phone takes the cross-process lock, so the probe can't swipe
// while the live bot runs a session (status just reads).
let release = () => {};
if (op && op !== 'status') {
  release = acquirePhoneLock(`ig-probe ${op}`);
  if (!release) {
    console.error(`the phone is in use: ${JSON.stringify(readPhoneLock())}`);
    process.exit(2);
  }
}
const n = (v) => parseInt(v, 10);

try {
  switch (op) {
    case 'status':
      console.log(JSON.stringify(await device.status(), null, 2));
      break;
    case 'launch':
      await device.launchInstagram({ launcherPackages: config.instagram.launcherPackages });
      console.log('foreground:', await device.foreground());
      break;
    case 'dump': {
      const { nodes } = await device.dumpScreen();
      const shown = args.includes('--all') ? nodes : nodes.filter(x => x.text || x.desc || x.id);
      for (const x of shown) {
        const b = x.bounds ? `[${x.bounds.x1},${x.bounds.y1}][${x.bounds.x2},${x.bounds.y2}]` : '';
        console.log([x.id.replace('com.instagram.android:id/', '#'), x.cls.split('.').pop(),
          x.text && `text=${JSON.stringify(x.text)}`, x.desc && `desc=${JSON.stringify(x.desc)}`,
          x.clickable && 'clickable', x.selected && 'selected', b].filter(Boolean).join('  '));
      }
      console.log(`\n${nodes.length} nodes`);
      break;
    }
    case 'screenshot':
      fs.writeFileSync(args[0], await device.screenshot());
      console.log('wrote', args[0]);
      break;
    case 'record':
      fs.writeFileSync(args[1], await device.recordScreen(n(args[0])));
      console.log('wrote', args[1]);
      break;
    case 'clip':
      fs.writeFileSync(args[1], await device.recordClip(n(args[0])));
      console.log('wrote', args[1]);
      break;
    case 'wake':
      await device.wake();
      break;
    case 'sleep':
      await device.sleep();
      break;
    case 'tap':
      await device.tap(n(args[0]), n(args[1]));
      break;
    case 'swipe':
      await device.swipe(n(args[0]), n(args[1]), n(args[2]), n(args[3]), args[4] ? n(args[4]) : 300);
      break;
    case 'back':
      await device.back();
      break;
    case 'open':
      await device.openInstagramUrl(args[0]);
      console.log('foreground:', await device.foreground());
      break;
    default:
      console.log('ops: status | launch | dump [--all] | screenshot <png> | record <secs> <mp4> | tap x y | swipe x1 y1 x2 y2 [ms] | back | open <url>');
  }
} catch (err) {
  console.error(`${err.constructor.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  release();
  if (process.env.IG_PROBE_LOG) {
    for (const c of device.recentCommands(100).reverse()) {
      console.log(`${new Date(c.ts).toISOString()} ${c.ok ? 'ok ' : 'ERR'} ${c.op} ${c.args} ${c.foreground ? `[fg ${c.foreground}]` : ''} ${c.error || ''}`);
    }
  }
}
