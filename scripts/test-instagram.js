// Exercises the Instagram device guard (src/instagram/device.js) against a fake ADB:
// device pinning (the call-gateway phone is never addressed), the Instagram-only
// foreground rule, URL/intent scoping, input validation and the command log.
// No phone needed. No test framework: direct imports + console asserts, mirroring
// scripts/test-imitate.js. Exits non-zero if a check fails.
//
// Usage:  node scripts/test-instagram.js

process.env.IG_DEVICE_SERIAL = 'IGSERIAL01';
process.env.IG_DEVICE_MODEL = 'PM2000';

const device = await import('../src/instagram/device.js');
const { IG_PACKAGE, ForeignAppError, DeviceError } = device;

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
    failures++;
  }
}
async function rejects(name, fn, cls) {
  try {
    await fn();
    check(`${name} (expected rejection)`, false);
  } catch (err) {
    check(name, cls ? err instanceof cls : true);
  }
}

// ── Fake ADB ────────────────────────────────────────────────────────────────
// Two phones on the bus: the call gateway (must never be addressed) and the Instagram phone.
const DEVICES = `List of devices attached
adb-GATEWAY0000001-abc123._adb-tls-connect._tcp device product:GatewayA model:GW100 device:GatewayA transport_id:1
192.0.2.140:41235   device product:PhoneModelB model:PM2000 device:PhoneModelB transport_id:2
`;
const fake = { fg: IG_PACKAGE, calls: [] };
function focusLine(pkg) {
  if (!pkg) return '  mCurrentFocus=Window{9f1 u0 NotificationShade}\n  mFocusedApp=null\n';
  return `  mCurrentFocus=Window{4a2 u0 ${pkg}/${pkg}.MainActivity}\n  mFocusedApp=ActivityRecord{77 u0 ${pkg}/.MainActivity t12}\n`;
}
device._setRunner(async (argv) => {
  fake.calls.push(argv);
  if (argv[0] === 'devices') return Buffer.from(DEVICES);
  const [flag, id, ...rest] = argv;
  if (flag !== '-s') throw new Error('unpinned command');
  const cmd = rest.join(' ');
  if (cmd === 'shell getprop ro.serialno') return Buffer.from(id === '192.0.2.140:41235' ? 'IGSERIAL01\n' : 'OTHER\n');
  if (cmd.startsWith("shell dumpsys window | grep -E 'isKeyguard")) return Buffer.from(`    mAwake=true\n    isKeyguardShowing=${!!fake.locked}\n`);
  if (cmd.startsWith('shell dumpsys window')) return Buffer.from(focusLine(fake.fg));
  if (cmd.startsWith('exec-out uiautomator dump')) {
    return Buffer.from(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">`
      + `<node text="" resource-id="com.instagram.android:id/clips_viewer" class="android.widget.FrameLayout" package="${fake.dumpPkg || IG_PACKAGE}" content-desc="" clickable="false" selected="false" bounds="[0,0][1080,2400]">`
      + `<node text="funny_cats &amp; co" resource-id="com.instagram.android:id/clips_author_username" class="android.widget.TextView" package="${IG_PACKAGE}" content-desc="" clickable="true" selected="false" bounds="[40,1900][400,1960]" />`
      + `</node></hierarchy>UI hierchary dumped to: /dev/tty`);
  }
  return Buffer.from('');
});
const addressed = () => fake.calls.filter(a => a[0] === '-s').map(a => a[1]);
const last = () => fake.calls[fake.calls.length - 1].slice(2).join(' ');

console.log('\nDevice pinning');
await device.tap(100, 200);
check('resolves to the Instagram phone by model + hardware serial', addressed().every(id => id === '192.0.2.140:41235'));
check('never addresses the call-gateway phone', !addressed().some(id => id.includes('NOTHING0000001')));
check('tap sent as input tap', last() === 'shell input tap 100 200');

device._resetForTests();
const savedModel = process.env.IG_DEVICE_MODEL;
const { config } = await import('../src/utils/config.js');
config.instagram.deviceModel = '';
await rejects('refuses to run without IG_DEVICE_MODEL', () => device.tap(1, 1), DeviceError);
config.instagram.deviceModel = 'A059';
config.instagram.deviceSerial = 'WRONG';
fake.calls.length = 0;
await rejects('wrong serial on a model-matched device → refused', () => device.tap(1, 1), DeviceError);
check('…and no input reached any phone', !fake.calls.some(a => a.includes('input')));
config.instagram.deviceModel = savedModel;
config.instagram.deviceSerial = 'IGSERIAL01';
device._resetForTests();

console.log('\nInstagram-only foreground');
fake.fg = 'com.whatsapp';
fake.calls.length = 0;
for (const [name, fn] of [
  ['tap', () => device.tap(10, 10)],
  ['swipe', () => device.swipe(500, 1800, 500, 600, 250)],
  ['back', () => device.back()],
  ['typeText', () => device.typeText('hello')],
  ['dumpScreen', () => device.dumpScreen()],
  ['screenshot', () => device.screenshot()],
  ['recordScreen', () => device.recordScreen(5)],
  ['openInstagramUrl', () => device.openInstagramUrl('https://www.instagram.com/reel/AbC123/')],
]) {
  await rejects(`${name} refused while WhatsApp is in front`, fn, ForeignAppError);
}
check('no input/capture command was sent while a foreign app was in front',
  !fake.calls.some(a => /input |screencap|screenrecord|uiautomator|am start/.test(a.join(' '))));
check('refusals are in the command log', device.recentCommands(50).some(c => c.op.endsWith(':refused') && c.foreground === 'com.whatsapp'));

fake.fg = null; // notification shade / keyguard: no app focus
await rejects('system overlay in front → refused (fail closed)', () => device.tap(10, 10), ForeignAppError);

fake.fg = null;
fake.calls.length = 0;
await rejects('launchInstagram refuses over the lock screen / shade', () => device.launchInstagram({ launcherPackages: ['com.example.launcher'] }), ForeignAppError);
check('…and sent no am start', !fake.calls.some(a => a.join(' ').includes('am start')));
fake.fg = 'com.whatsapp';
await rejects('launchInstagram refuses over a foreign app', () => device.launchInstagram({ launcherPackages: ['com.example.launcher'] }), ForeignAppError);
fake.fg = 'com.example.launcher';
await device.launchInstagram({ launcherPackages: ['com.example.launcher'] });
check('launchInstagram from the launcher targets the Instagram component', last() === 'shell am start -W -n com.instagram.android/.activity.MainTabActivity');

fake.fg = IG_PACKAGE;
fake.dumpPkg = 'com.android.systemui';
await rejects('dump containing another package → refused', () => device.dumpScreen(), ForeignAppError);
fake.dumpPkg = null;
const { nodes } = await device.dumpScreen();
check('dump parsed, entities decoded', nodes.some(n => n.text === 'funny_cats & co' && n.bounds?.x2 === 400));

fake.locked = true;
check('lockState reads the keyguard', (await device.lockState()).locked === true);
fake.locked = false;
check('lockState unlocked', (await device.lockState()).locked === false);

console.log('\nURL + intent scoping');
await device.openInstagramUrl('https://www.instagram.com/reel/AbC123/');
check('VIEW intent is scoped to Instagram', /-d 'https:\/\/www\.instagram\.com\/reel\/AbC123\/' -p com\.instagram\.android$/.test(last()));
for (const bad of [
  'https://evil.example/reel/x',
  'http://www.instagram.com/reel/x/',
  "https://www.instagram.com/reel/x/'; reboot; '",
  'https://www.instagram.com/accounts/password/change/',
  'https://www.instagram.com/reel/x/?a=b;rm',
]) {
  await rejects(`rejects ${bad}`, () => device.openInstagramUrl(bad), DeviceError);
}

console.log('\nInput validation');
await rejects('non-integer tap', () => device.tap(1.5, 2), DeviceError);
await rejects('negative swipe', () => device.swipe(-1, 0, 0, 0), DeviceError);
await rejects('emoji in typeText', () => device.typeText('nice 😂'), DeviceError);
await rejects('newline in typeText', () => device.typeText('a\nreboot'), DeviceError);
await device.typeText("it's $(reboot) `x` & y");
check('typeText single-quotes shell metacharacters', last() === `shell input text 'it'\\''s%s$(reboot)%s\`x\`%s&%sy'`);
check('typed text is not written to the command log', device.recentCommands(1)[0].args === '(22 chars)');

console.log('\nButtons that leave Instagram');
const btn = (id, desc) => ({ id: `com.instagram.android:id/${id}`, desc, text: '', pkg: IG_PACKAGE, bounds: { x1: 0, y1: 0, x2: 100, y2: 100 } });
for (const [id, desc] of [['button', 'WhatsApp'], ['button', 'Share'], ['button', 'Download'], ['button', 'Add to story'], ['x', 'Share to Facebook'], ['x', 'Open in browser']]) {
  fake.calls.length = 0;
  await rejects(`tapNode refuses "${desc}"`, () => device.tapNode(btn(id, desc)), DeviceError);
  check(`…no tap sent for "${desc}"`, !fake.calls.some(a => a.join(' ').includes('input tap')));
}
for (const [id, desc] of [['x', 'Audio call'], ['x', 'Video call'], ['user_admin_tools_button', 'More options for AB.'], ['x', 'Add people'], ['row_thread_composer_button_gallery', 'Gallery'], ['row_thread_composer_voice', 'Voice message, press and hold to record'], ['button', 'Follow VK']]) {
  fake.calls.length = 0;
  await rejects(`tapNode never presses "${desc}"`, () => device.tapNode(btn(id, desc)), DeviceError);
  check(`…no tap sent for "${desc}"`, !fake.calls.some(a => a.join(' ').includes('input tap')));
}
await rejects('"Remove from saved" refused without an explicit allowance', () => device.tapNode(btn('row_feed_button_save', 'Remove from saved')), DeviceError);
await device.tapNode(btn('row_feed_button_save', 'Remove from saved'), { allow: (n) => /^remove from saved$/i.test(n.desc) });
check('…and allowed with one', last() === 'shell input tap 50 50');
await device.tapNode(btn('direct_share_button', 'Share'));
check("Instagram's own Share button is allowed", last() === 'shell input tap 50 50');
await device.tapNode(btn('recipient_toggle', ''));
check('recipient toggle is allowed', last() === 'shell input tap 50 50');

console.log('\nScreen readers');
const S = await import('../src/instagram/screens.js');
const n = (id, extra = {}) => ({ id: id ? `com.instagram.android:id/${id}` : '', text: '', desc: '', cls: '', pkg: IG_PACKAGE, clickable: false, selected: false, bounds: { x1: 0, y1: 0, x2: 10, y2: 10 }, ...extra });
const reelsNodes = [
  n('clips_viewer_view_pager'),
  n('clips_author_username', { text: 'daily_memes  ', clickable: true }),
  n('clips_caption_component', { bounds: { x1: 45, y1: 2120, x2: 933, y2: 2181 } }),
  n('', { text: 'cat vs noodles …', bounds: { x1: 45, y1: 2125, x2: 600, y2: 2170 } }),
  n('', { desc: 'See more', bounds: { x1: 45, y1: 2120, x2: 933, y2: 2181 } }),
  n('like_button', { desc: 'Like', selected: true, clickable: true }),
  n('like_count', { text: 'Like number is 370377. View likes' }),
  n('save_button', { desc: 'Save', clickable: true }),
  n('direct_share_button', { desc: 'Share', clickable: true }),
];
const rr = S.readReel(reelsNodes);
check('readReel: account, caption, like state, counts', rr.account === 'daily_memes' && rr.caption === 'cat vs noodles' && rr.liked && !rr.saved && rr.likeCount === 370377 && !rr.isAd);
check('screenKind reels', S.screenKind(reelsNodes) === 'reels');
check('reelKey ignores our own like (count +1)', S.reelKey(rr) === S.reelKey({ ...rr, likeCount: rr.likeCount + 1 }));
check('ad label detected', S.readReel([...reelsNodes, n('', { text: 'Sponsored' })]).isAd);
check('blocker: security check text', !!S.detectBlocker([n('', { text: "Confirm it's you" })]));
check('blocker: action blocked', !!S.detectBlocker([n('', { text: 'Try Again Later' })]));
check('no blocker on a normal reel', S.detectBlocker(reelsNodes) === null);
const rowAt = (y, name, second, toggleDy = 0) => [
  n('row_user_primary_name', { text: name, bounds: { x1: 214, y1: y, x2: 500, y2: y + 45 } }),
  n('row_user_secondary_name', { text: second, bounds: { x1: 214, y1: y + 45, x2: 600, y2: y + 89 } }),
  n('recipient_toggle', { bounds: { x1: 922, y1: y - 1 + toggleDy, x2: 1012, y2: y + 89 + toggleDy } }),
];
const sheet = [n('direct_private_share_recipients_recycler_view'), ...rowAt(415, 'Squad', 'AB, friend_one and 4 others'), ...rowAt(565, 'Squadron', 'squadron_studio'), ...rowAt(753, 'Squad', 'squad_fan_page')];
const rows = S.shareSearchRows(sheet);
check('share rows parsed with their toggles', rows.length === 3 && rows.every(r => r.toggle));
const exact = rows.filter(r => r.name === 'Squad');
check('exact-name filter keeps both "Squad" rows (caller must then refuse ambiguity)', exact.length === 2);
check('group row looks like a group', S.looksLikeGroup(exact[0]) && !S.looksLikeGroup(exact[1]));
check('screenKind share_sheet', S.screenKind(sheet) === 'share_sheet');
const postNodes = [
  n('row_feed_photo_profile_name', { text: 'some.creator  ', clickable: true }),
  n('secondary_label', { text: " Taylor Swift · Blank Space (Taylor's Version)" }),
  n('row_feed_button_share', { desc: 'Send post. 61.6K shares.' }),
  n('row_feed_button_save', { desc: 'Remove from saved', selected: true, clickable: true }),
];
const om = S.readOpenMedia(postNodes);
check('feed viewer (from Saved): account, audio, share, saved', om.account === 'some.creator' && om.audio.startsWith('Taylor Swift') && om.shareNode && om.saved);
check('readOpenMedia prefers the Reels viewer when present', S.readOpenMedia(reelsNodes).account === 'daily_memes');
check('screenKind sheet (first-Save collections sheet over a reel)', S.screenKind([...reelsNodes, n('bottom_sheet_drag_handle_frame'), n('background_dimmer', { desc: 'Dismiss' })]) === 'sheet');
check('selectedChats reads "Squad Chat selected"', S.selectedChats([n('direct_share_sheet_grid_view_pog', { desc: 'Squad Chat selected' })])[0] === 'Squad');

console.log('\nGroup thread readers');
const b = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const tv = (text, bounds, id = '') => n(id, { text, cls: 'android.widget.TextView', bounds });
check('inbox row: unread + count', JSON.stringify((({ unread, newCount }) => ({ unread, newCount }))(S.readInboxRow([n('', { desc: 'Squad, unread, 2 new messages ·, 19m', bounds: b(0, 896, 1080, 1110) })], 'Squad'))) === '{"unread":true,"newCount":2}');
check('inbox row: read', S.readInboxRow([n('', { desc: 'Squad, You: Me daily…, 2h', bounds: b(0, 896, 1080, 1110) })], 'Squad').unread === false);
check('inbox row: other chats are not the group', S.readInboxRow([n('', { desc: 'Squad Official, unread, 1 new message', bounds: b(0, 0, 9, 9) })], 'Squad') === null);
const thread = [
  n('direct_thread_toggle_action_bar', { bounds: b(0, 80, 1080, 237) }),
  n('thread_title', { text: 'Squad', bounds: b(310, 125, 487, 175) }),
  n('reel_share_item_view', { bounds: b(579, 238, 1057, 1027) }),
  n('title_text', { text: 'some.creator', bounds: b(704, 238, 1014, 257) }),
  tv('Me daily in office client calls', b(469, 1031, 1057, 1136)),
  tv('❤', b(500, 1142, 551, 1193)),
  n('username', { text: 'friend_one', bounds: b(185, 1238, 1080, 1276) }),
  tv('Nice one', b(158, 1295, 356, 1400)),
  tv('❤', b(189, 1406, 240, 1457)),
  n('direct_context_reply_context_info_text_view', { text: 'Test Friend replied to you', bounds: b(201, 1502, 1080, 1540) }),
  n('context_reply_context_message_container', { bounds: b(201, 1562, 440, 1992) }),
  n('reel_share_item_view', { bounds: b(201, 1562, 440, 1992) }),
  tv('Hey there', b(157, 2014, 510, 2119), 'direct_text_message_text_view'),
  n('message_footer_label', { text: 'Tap and hold to react', cls: 'android.widget.TextView', bounds: b(157, 2119, 515, 2168) }),
  n('message_composer_bar', { bounds: b(0, 2168, 1080, 2287) }),
];
const msgs = S.parseThread(thread);
check('thread: 4 messages (reaction chips, quoted reel and footer skipped)', msgs.length === 4);
check('thread: our reel share + caption are fromMe', msgs[0].fromMe && msgs[0].kind === 'reel' && msgs[0].reelAccount === 'some.creator' && msgs[1].fromMe);
check('thread: "Adipoli" is from friend_one', !msgs[2].fromMe && msgs[2].sender === 'friend_one' && msgs[2].text === 'Nice one');
check('thread: reply sender from "X replied to you"', msgs[3].sender === 'Test Friend' && msgs[3].replyToMe && msgs[3].text === 'Hey there');
const people = S.readMembers([
  n('row_header_textview', { text: 'You', bounds: b(45, 260, 300, 300) }),
  n('row_user_primary_name', { text: 'Bot', bounds: b(200, 452, 600, 497) }),
  n('row_user_secondary_name', { text: 'bot.account', bounds: b(200, 497, 600, 540) }),
  n('row_header_textview', { text: 'Others (2)', bounds: b(45, 984, 300, 1020) }),
  n('row_user_primary_name', { text: 'friend_one', bounds: b(200, 1402, 600, 1447) }),
  n('row_user_primary_name', { text: 'Test Friend', bounds: b(200, 1584, 600, 1629) }),
  n('row_user_secondary_name', { text: 'Admin • tess.j', bounds: b(200, 1629, 600, 1672) }),
]);
check('members: self, no-display-name user, admin', people.length === 3 && people[0].isSelf && people[1].username === 'friend_one' && people[2].username === 'tess.j' && people[2].admin);

console.log('\nChat: is he being talked to?');
const { mentionsBot } = await import('../src/instagram/chat.js');
const { getPersona } = await import('../src/utils/config.js');
const nm = getPersona().name.toLowerCase();
check('mention: exact name', mentionsBot(`hey ${nm}`));
check('mention: stretched vocative ("…aa")', mentionsBot(`Eda ${nm}aa`));
check('mention: with punctuation', mentionsBot(`${nm.toUpperCase()}!!`));
check('no mention in ordinary chat', !mentionsBot('adipoli, see you at 7'));

console.log('\nDecision rule');
const { decide } = await import('../src/instagram/judge.js');
const A = (humour, fit, conf = 0.7, extra = {}) => ({ humour: { score: humour, confidence: conf }, fit: { score: fit, confidence: conf }, ...extra });
check('strong → like_and_queue', decide(A(2.6, 2.4)).action === 'like_and_queue');
check('good → like', decide(A(1.9, 1.0)).action === 'like');
check('meh → skip', decide(A(1.0, 1.0)).action === 'skip');
check('hazard over threshold → skip', decide(A(2.9, 2.9, 0.8, { hazard_politics: { noul: 0.3 } })).reason.startsWith('hazard'));
check('ad → skip', decide(A(2.9, 2.9, 0.8, { is_ad: { noul: 0.9 } })).reason === 'ad');
check('low confidence → skip', decide(A(2.9, 2.9, 0.2)).action === 'skip');
check('nobody → no target', decide(A(2.6, 2.4, 0.7, { for_whom: { choice: 'nobody' } })).forWhom === null);

console.log('\nSchedule');
const { planDay, isAwake } = await import('../src/instagram/scheduler.js');
config.sleepStartHour = 0; config.sleepEndHour = 7; config.timezone = 'UTC';
const dayStart = Math.floor(new Date('2026-10-28T00:00:00Z').getTime() / 1000);
const slots = planDay(dayStart, 4, dayStart - 1);
check('4 slots planned', slots.length === 4);
check('all slots in waking hours (07:00–24:00 local)', slots.every(s => isAwake(s.at)));
check('slots ≥ 75 min apart', slots.every((s, i) => i === 0 || s.at - slots[i - 1].at >= 75 * 60));
check('no slots in the past', planDay(dayStart, 4, dayStart + 23 * 3600).every(s => s.at > dayStart + 23 * 3600));

console.log('\nCaption + taste');
const { toTypeable } = await import('../src/instagram/caption.js');
check('caption made typeable (emoji/curly quotes/dashes)', toTypeable('ithu nee thanne 😂 — “sure”…') === 'ithu nee thanne - "sure"...');
check('Malayalam script stripped (cannot be typed)', toTypeable('ഇത് നീ തന്നെ') === '');
const { validateTaste } = await import('../src/instagram/taste.js');
let tasteErr = null;
try { validateTaste({ likes: [] }); } catch (err) { tasteErr = err; }
check('taste card needs likes', !!tasteErr);
check('taste card cleaned', validateTaste({ likes: [' memes ', ''], humour: 'dry', extra: 1 }).likes.length === 1);

console.log('\nStore (scratch DB)');
const IG_TEST_DB = './data/test-instagram.db';
// A crashed earlier run leaves its scratch DB behind (and its rows would skew the
// caps below): start from nothing. Only this scratch file and its WAL/SHM siblings.
for (const f of ['', '-wal', '-shm']) (await import('fs')).rmSync(`${IG_TEST_DB}${f}`, { force: true });
process.env.DB_PATH = IG_TEST_DB;
config.dbPath = (await import('path')).resolve(IG_TEST_DB);
const { runMigrations, closeDb } = await import('../src/memory/db.js');
runMigrations();
const store = await import('../src/memory/igStore.js');
const sid = store.createSession({ trigger: 'manual', initiatedBy: 'test' });
const r1 = store.insertReel({ session_id: sid, account: 'a', description: 'auto driver parks with his hands', humour: 2.0, fit: 2.0, share_state: 'queued', hazards: [] });
const r2 = store.insertReel({ session_id: sid, account: 'b', description: 'cat steals noodles', humour: 2.8, fit: 2.6, share_state: 'queued', hazards: [] });
store.insertReel({ session_id: sid, account: 'c', description: 'ad', action: 'skip' });
check('queue sorted best first', store.listQueue().map(r => r.id).join() === `${r2},${r1}`);
check('reel log search (FTS)', store.listReels({ q: 'noodles' }).length === 1 && store.listReels({ q: 'driver' })[0].id === r1);
check('FTS input cannot inject operators', store.listReels({ q: 'noodles OR " NEAR(' }).length === 0);
store.updateReel(r2, { share_state: 'sent', shared_at: Math.floor(Date.now() / 1000) });
check('sent leaves the queue and counts as shared today', store.listQueue().length === 1 && store.countToday('shared', 0) === 1);
const { ingest } = await import('../src/instagram/chat.js');
const vis = (arr) => arr.map(([fromMe, sender, text]) => ({ fromMe, sender, kind: 'text', text, reelAccount: null, node: null }));
const screen1 = vis([[true, null, 'reel caption'], [false, 'friend_one', 'Nice one'], [false, 'Test Friend', 'Hey there']]);
const first = ingest(screen1, 2);
check('ingest: first read → the 2 newest from others are new', first.length === 2 && first[1].text === 'Hey there');
check('ingest: same screen again → nothing new (no double reply)', ingest(screen1, 2).length === 0);
check('ingest: inbox says "1 new" but it was a sticker → nothing new', ingest(screen1, 1).length === 0);
const screen2 = vis([[true, null, 'reel caption'], [false, 'friend_one', 'Nice one'], [false, 'Test Friend', 'Hey there'], [false, 'friend_one', 'lol'], [false, 'friend_one', 'lol']]);
const second = ingest(screen2, 2);
check('ingest: repeated "lol" twice → both new (occurrence 1 and 2)', second.length === 2 && second.every(m => m.text === 'lol'));
check('ingest: re-read after that → nothing new', ingest(screen2, 3).length === 0);
check('ingest: history before the window is backfill, not answered', ingest(vis([[false, 'x', 'old msg'], [false, 'y', 'new msg']]), 1).map(m => m.text).join() === 'new msg');

console.log('\nShare cap + warmup gates (no phone touched)');
{
  const session = await import('../src/instagram/session.js');
  const { getDb } = await import('../src/memory/db.js');
  const saved = { ...config.instagram };
  config.instagram.sharesPerDay = 1;        // r2 above was sent today
  config.instagram.warmupDays = 10;
  const before = fake.calls.length;
  let capErr = null;
  try { await session.shareFromQueue(r1); } catch (err) { capErr = err; }
  check('queue approval past IG_SHARES_PER_DAY → refused with the reason', capErr instanceof session.SessionError && /daily share cap reached \(1\/1/.test(capErr.message));
  check('…before any phone command', fake.calls.length === before);
  check('…and the queued reel keeps the reason for the dashboard', /daily share cap/.test(store.getReel(r1).share_error || '') && store.listQueue().some(r => r.id === r1));
  // A cleared caption is "no caption", not "use the stored one" / "he writes one".
  let wrote = 0;
  const writer = async () => { wrote++; return 'his own caption'; };
  session.setShareCaption(r1, 'typed by the owner');
  session.setShareCaption(r1, '');
  check('clearing a caption stores an empty one (not NULL, not the old text)', store.getReel(r1).share_caption === '');
  check('…and the share types no caption, without asking him for one', await session.captionForShare(store.getReel(r1), writer) === '' && wrote === 0);
  check('no stored caption → he writes one', await session.captionForShare({ ...store.getReel(r1), share_caption: null }, writer) === 'his own caption' && wrote === 1);
  config.instagram.sharesPerDay = 5;
  config.instagram.approvalMode = 'approve-each';
  check('warmup: a manual session with ALLOW SHARING does not share', session.inSessionShareGate({ allowShare: true }).share === false
    && /warmup/.test(session.inSessionShareGate({ allowShare: true }).reason));
  config.instagram.approvalMode = 'auto';
  check('warmup: auto approval mode does not share either', session.inSessionShareGate({ allowShare: false }).share === false);
  getDb().prepare('UPDATE ig_sessions SET started_at = ?').run(Math.floor(Date.now() / 1000) - 30 * 86400);
  check('after warmup: auto mode shares', session.inSessionShareGate({ allowShare: false }).share === true);
  config.instagram.approvalMode = 'approve-each';
  check('after warmup: approve-each shares only with ALLOW SHARING', session.inSessionShareGate({ allowShare: true }).share === true
    && session.inSessionShareGate({ allowShare: false }).share === false);
  config.instagram.sharesPerDay = 1;
  check('after warmup: the daily cap still stops an in-session share', session.inSessionShareGate({ allowShare: true }).share === false);
  Object.assign(config.instagram, saved);
}
console.log('\nQueue share: finding the saved reel (fake screens, no phone)');
{
  const session = await import('../src/instagram/session.js');
  // A Saved grid of tiles (display names only); opening tile i shows the feed viewer of accounts[i].
  const grid = (count) => Array.from({ length: count }, (_, i) => n('', { desc: `Reel by Someone ${i} at row 1, column ${i + 1}`, clickable: true, bounds: { x1: i * 100, y1: 300, x2: i * 100 + 90, y2: 400 } }));
  const fakeIo = (accounts) => {
    let open = null;
    const taps = [];
    return { taps, io: {
      readScreen: async () => (open == null ? grid(accounts.length) : [n('row_feed_photo_profile_name', { text: accounts[open] }), n('row_feed_button_save', { desc: 'Remove from saved', selected: true })]),
      tapNode: async (t) => { open = Number(t.desc.match(/column (\d+)/)[1]) - 1; taps.push(open); },
      back: async () => { open = null; },
      sleep: async () => {},
    } };
  };
  let f = fakeIo(['other', 'creator.one', 'someone']);
  const opened = await session.openSavedReelBy('creator.one', f.io);
  check('one saved reel by the account → that one is opened', opened.account === 'creator.one' && f.taps.at(-1) === 1);
  f = fakeIo(['creator.one', 'other', 'creator.one']);
  let err = null;
  try { await session.openSavedReelBy('creator.one', f.io); } catch (e) { err = e; }
  check('two saved reels by the same account → refused (never shares/un-saves the wrong one)', err instanceof session.SessionError && /more than one saved reel/.test(err.message));
  f = fakeIo(['other']);
  err = null;
  try { await session.openSavedReelBy('creator.one', f.io); } catch (e) { err = e; }
  check('no saved reel by the account → not found', err instanceof session.SessionError && /not found/.test(err.message));
}

console.log('\nPhone lock');
{
  const { acquirePhoneLock } = await import('../src/instagram/phoneLock.js');
  const fsm = await import('fs');
  const lockFile = `${config.projectRoot}/data/instagram/phone.lock`;
  fsm.mkdirSync(`${config.projectRoot}/data/instagram`, { recursive: true });
  const had = fsm.existsSync(lockFile) ? fsm.readFileSync(lockFile) : null;
  fsm.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner: 'auto session', at: Date.now() - 40 * 60_000 }));
  check('a lock held 40 min by a live process is still held (a long session is not taken over)', acquirePhoneLock('ig-probe dump') === null);
  fsm.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, owner: 'auto session', at: Date.now() }));
  const rel = acquirePhoneLock('ig-probe dump');
  check('a dead pid\'s lock is taken over', typeof rel === 'function');
  rel?.();
  if (had) fsm.writeFileSync(lockFile, had); else fsm.rmSync(lockFile, { force: true });
}

closeDb();
for (const f of ['', '-wal', '-shm']) (await import('fs')).rmSync(`${IG_TEST_DB}${f}`, { force: true });

console.log('\nNo generic shell');
check('module exports no shell/exec/run function', !Object.keys(device).some(k => /^(shell|exec|run|adb)$/i.test(k)));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
