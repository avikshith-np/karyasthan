// Server-side check of the call audio path without the phone: originates a Local
// channel into the [calltest] dialplan (which records), bridges it to externalMedia,
// and plays a 300 Hz tone through src/calls/rtp.js. Then measure /tmp/calltest-sink.wav
// inside the Asterisk container. Uses its own ARI app name so the bot is unaffected.
import 'dotenv/config';
import { AriClient } from '../src/calls/ari.js';
import { RtpEndpoint, Resampler } from '../src/calls/rtp.js';
const log = { info: console.log, warn: console.log, error: console.log, debug() {}, child() { return log; } };
const ari = new AriClient({ url: process.env.ARI_URL, user: process.env.ARI_USER, password: process.env.ARI_PASSWORD, app: 'karyasthan-test', logger: log });
ari.on('StasisStart', async (ev) => {
  const ch = ev.channel;
  if (ch.name.startsWith('UnicastRTP/')) return;
  const rtp = new RtpEndpoint(log);
  const port = await rtp.bind('127.0.0.1');
  const ext = await ari.externalMedia({ host: `127.0.0.1:${port}` });
  console.log('externalMedia channelvars', ext.channelvars);
  rtp.setRemote(ext.channelvars?.UNICASTRTP_LOCAL_ADDRESS, ext.channelvars?.UNICASTRTP_LOCAL_PORT);
  const br = await ari.createBridge();
  await ari.addToBridge(br.id, [ch.id, ext.id]);
  let rxVoiced = 0, rxPeak = 0;
  rtp.on('audio', (pcm) => { let p = 0; for (let i = 0; i + 1 < pcm.length; i += 2) p = Math.max(p, Math.abs(pcm.readInt16LE(i))); if (p > 500) rxVoiced++; rxPeak = Math.max(rxPeak, p); });
  setTimeout(() => console.log('received back: voiced frames', rxVoiced, 'peak', rxPeak), 4900);
  const rs = new Resampler();
  const tone = Buffer.alloc(24000 * 2 * 4);
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 300 * i / 24000)), i * 2);
  for (let off = 0; off < tone.length; off += 4800) rtp.enqueue(rs.process(tone.subarray(off, off + 4800)));
  setTimeout(async () => {
    console.log('payload type', rtp.rxPayloadType, 'stats', rtp.stats);
    rtp.close(); await ari.destroyBridge(br.id).catch(() => {}); await ari.hangup(ext.id).catch(() => {});
    await ari.hangup(ch.id).catch(() => {}); ari.close(); setTimeout(() => process.exit(0), 300);
  }, 5000);
});
ari.on('connected', () => ari.originate({ endpoint: process.env.TEST_ENDPOINT || 'Local/sink@calltest', appArgs: 'test', timeout: 10 })
  .catch(e => { console.log('originate failed', e.message); process.exit(1); }));
ari.connect();
setTimeout(() => { console.log('timeout'); process.exit(1); }, 20000);
