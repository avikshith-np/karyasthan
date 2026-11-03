// Audio-path check for phone calls: answers ONE inbound call via ARI and echoes its
// audio back through src/calls/rtp.js (no Gemini). Needs gateway takeover on.
// Usage: node scripts/call-echo.js   (the bot must not be running its ARI app)
import 'dotenv/config';
import { AriClient } from '../src/calls/ari.js';
import { RtpEndpoint, Resampler } from '../src/calls/rtp.js';
const log = { info: console.log, warn: console.log, error: console.log, debug() {}, child() { return log; } };
const ari = new AriClient({ url: process.env.ARI_URL, user: process.env.ARI_USER, password: process.env.ARI_PASSWORD, app: 'karyasthan', logger: log });
let done = false;
ari.on('StasisStart', async (ev) => {
  const ch = ev.channel;
  if (ch.name.startsWith('UnicastRTP/') || done) return;
  done = true;
  console.log('inbound from', ch.caller?.number ? '…' + ch.caller.number.slice(-2) : '?');
  const rtp = new RtpEndpoint(log);
  const port = await rtp.bind('127.0.0.1');
  const down = new Resampler(16000, 8000);
  rtp.on('audio', (pcm) => rtp.enqueue(down.process(pcm))); // echo (16 kHz in, 8 kHz back)
  await ari.answer(ch.id);
  const ext = await ari.externalMedia({ host: `127.0.0.1:${port}` });
  rtp.setRemote(ext.channelvars?.UNICASTRTP_LOCAL_ADDRESS, ext.channelvars?.UNICASTRTP_LOCAL_PORT);
  const br = await ari.createBridge();
  await ari.addToBridge(br.id, [ch.id, ext.id]);
  console.log('bridged; echoing (pt will be logged)');
  setTimeout(() => console.log('payload type', rtp.rxPayloadType, 'stats', rtp.stats), 3000);
  const end = async (why) => { console.log('end:', why, rtp.stats); rtp.close(); await ari.destroyBridge(br.id).catch(()=>{}); await ari.hangup(ext.id).catch(()=>{}); await ari.hangup(ch.id).catch(()=>{}); ari.close(); setTimeout(() => process.exit(0), 300); };
  ari.on('StasisEnd', (e) => { if (e.channel.id === ch.id) end('caller hung up'); });
  setTimeout(() => end('60s limit'), 60000);
});
ari.connect();
setTimeout(() => { if (!done) { console.log('no call within 10 min'); process.exit(1); } }, 600000);
