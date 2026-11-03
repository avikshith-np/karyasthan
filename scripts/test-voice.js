// Exercises voice notes + imitate-voice without WhatsApp: marker/mood parsing,
// the speech-tag whitelist, postProcess stripping, person_voice storage, the
// imitation voice gates (skill × opt-in × enrolled × cap), prompt assembly, DM
// enrollment guards, the fail-closed cloned-voice quality gate, and audio
// conversion. No test framework: direct imports + console asserts, mirroring
// scripts/test-imitate.js. Exits non-zero if a check fails.
//
// Usage:  node scripts/test-voice.js [--live]
//   --live  also hits the Gemini API: one real TTS note, the fallback path, a
//           bogus cloned voice (must NOT fall back), and a replication request
//           with silent audio (must be refused by the consent check).
// Runs against an isolated scratch DB (data/test-voice.db), deleted on exit.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

process.env.DB_PATH = './data/test-voice.db';
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const LIVE = process.argv.includes('--live');

const { config } = await import('../src/utils/config.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
const { storeMessage } = await import('../src/memory/messageStore.js');
const { upsertPerson } = await import('../src/memory/peopleStore.js');
const {
  extractVoiceMarker, extractSingMarker, sanitizeSpeechText, SPEECH_TAG_RE, generateVoiceNote,
} = await import('../src/brain/voiceGen.js');
const { postProcess } = await import('../src/brain/postProcess.js');
const { getPersonVoice, savePersonVoice, revokePersonVoice, listOrphanedVoices } = await import('../src/memory/voiceStore.js');
const {
  setImitationTarget, setImitationVoice, recordImitationVoiceNote, resolveImitationVoice,
  getImitationTarget, loadImitationModes, clearImitationTarget,
} = await import('../src/behavior/imitationState.js');
const { loadSkills, setSkillEnabled } = await import('../src/skills/skillRunner.js');
const { buildImitationBundle, getSpokenExemplars } = await import('../src/personality/styleProfiler.js');
const { buildConversationContext, buildSystemPrompt } = await import('../src/personality/systemPrompt.js');
const { claimVoiceEnrollment, getEnrollmentSession } = await import('../src/whatsapp/voiceEnrollment.js');
const { evaluateResponse } = await import('../src/brain/qualityGate.js');
const { toWav24kMono, enrollVoice, createReplicatedVoice, VoiceCloneError } = await import('../src/brain/voiceClone.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`); }
}
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

// ── Fixtures ────────────────────────────────────────────────────────────────
runMigrations();
const db = getDb();
await loadSkills();

const GROUP = 'voicetest@g.us';
const TARGET = '111111111111111@lid';
const OTHER = '222222222222222@lid';
const OUTSIDER = '333333333333333@lid';
db.prepare(`INSERT OR IGNORE INTO groups (jid, name) VALUES (?, ?)`).run(GROUP, 'Voice Test');
upsertPerson(TARGET, null, 'Bob');
upsertPerson(OTHER, null, 'Alice');
upsertPerson(OUTSIDER, null, 'Eve');
for (const p of [TARGET, OTHER]) db.prepare(`INSERT OR IGNORE INTO group_members (group_jid, person_jid) VALUES (?, ?)`).run(GROUP, p);

const now = Math.floor(Date.now() / 1000);
for (let i = 0; i < 60; i++) {
  storeMessage({
    id: `t${i}`, groupJid: GROUP, senderJid: i % 2 ? TARGET : OTHER, senderName: i % 2 ? 'Bob' : 'Alice',
    content: i % 2 ? `macha ${i} scene aanu 😂` : `hello ${i}`, messageType: 'text',
    isFromSelf: false, timestamp: now - 3600 + i * 10, metadata: {},
  });
}
storeMessage({
  id: 'a1', groupJid: GROUP, senderJid: TARGET, senderName: 'Bob',
  content: 'aa da njan ippo varaam, oru ten minutes, traffic aanu', messageType: 'audio',
  isFromSelf: false, timestamp: now - 100, metadata: {},
});

try {
  // ── 1. Markers ─────────────────────────────────────────────────────────────
  console.log('\n[markers]');
  const m1 = extractVoiceMarker('haha [VOICE(sleepy): എടാ <laugh> ശരി] cap');
  check('mood parsed', m1?.mood === 'sleepy' && m1.text === 'എടാ <laugh> ശരി' && m1.caption === 'haha\ncap');
  const m2 = extractVoiceMarker('[VOICE: plain text]');
  check('plain marker, no mood', m2?.text === 'plain text' && m2.mood === null);
  check('truncated marker', extractSingMarker('[SING: la la la')?.text === 'la la la');
  check('no marker → null', extractVoiceMarker('just text') === null);
  const pp = postProcess('ok da <laugh> [VOICE(angry): hidden]', [], { isGroup: true });
  check('postProcess strips mood marker + speech tag', pp && !/VOICE|hidden|<laugh>/.test(pp.text));

  // ── 2. Speech tags ─────────────────────────────────────────────────────────
  console.log('\n[speech tags]');
  const st = sanitizeSpeechText('a <laugh> b <Short  Pause> c <evil> d <sigh><sigh> x > y');
  check('whitelist kept, max 3, junk + stray brackets dropped', st === 'a <laugh> b <short pause> c d <sigh> x y');
  check('legacy models get no tags', sanitizeSpeechText('a <laugh> b', { allowTags: false }) === 'a b');
  check('SPEECH_TAG_RE matches cues only', 'x <laugh> <b> y'.replace(SPEECH_TAG_RE, '') === 'x  <b> y');

  // ── 3. person_voice store ──────────────────────────────────────────────────
  console.log('\n[voice store]');
  check('no voice initially', getPersonVoice(TARGET) === null);
  savePersonVoice({ personJid: TARGET, voiceId: 'voice_test1', languageCode: 'ml-IN', consentRef: 'c1', via: 'dm', expireTime: now + 86400 });
  check('active after save', getPersonVoice(TARGET)?.voice_id === 'voice_test1');
  savePersonVoice({ personJid: OUTSIDER, voiceId: 'voice_orphan', via: 'dm', expireTime: now + 86400 });
  check('orphan = owner in no group', listOrphanedVoices().map(v => v.person_jid).join() === OUTSIDER);
  revokePersonVoice(OUTSIDER, 'test');
  check('revoked → inactive but row kept', getPersonVoice(OUTSIDER) === null && getPersonVoice(OUTSIDER, { includeInactive: true })?.revoked_at);
  savePersonVoice({ personJid: OTHER, voiceId: 'voice_expired', via: 'dm', expireTime: now - 10 });
  check('expired → inactive', getPersonVoice(OTHER) === null);

  // ── 4. Imitation voice gates ───────────────────────────────────────────────
  console.log('\n[imitation voice gates]');
  setSkillEnabled('imitate-voice', true);
  config.imitate.voiceMaxPerSession = 3; // fixed cap for these checks, whatever .env says
  setImitationTarget(GROUP, { targetJid: TARGET, label: 'Bob', durationMinutes: 30 });
  check('opt-in off → no voice', resolveImitationVoice(getImitationTarget(GROUP)) === null);
  setImitationVoice(GROUP, true);
  const rv = resolveImitationVoice(getImitationTarget(GROUP));
  check('all gates pass → voice id + remaining', rv?.voiceId === 'voice_test1' && rv.remaining === config.imitate.voiceMaxPerSession);
  setSkillEnabled('imitate-voice', false);
  check('kill switch off → no voice', resolveImitationVoice(getImitationTarget(GROUP)) === null);
  setSkillEnabled('imitate-voice', true);
  for (let i = 0; i < config.imitate.voiceMaxPerSession; i++) recordImitationVoiceNote(GROUP);
  check('cap reached → no voice', resolveImitationVoice(getImitationTarget(GROUP)) === null);
  loadImitationModes();
  const reloaded = getImitationTarget(GROUP);
  check('use_voice + count persist across reload', reloaded.useVoice === true && reloaded.voiceNotesSent === config.imitate.voiceMaxPerSession);
  setImitationTarget(GROUP, { targetJid: TARGET, label: 'Bob', durationMinutes: 30, useVoice: true });
  check('re-activation resets the session cap', resolveImitationVoice(getImitationTarget(GROUP))?.remaining === config.imitate.voiceMaxPerSession);
  config.imitate.voiceMaxPerSession = 0;
  for (let i = 0; i < 10; i++) recordImitationVoiceNote(GROUP);
  check('cap 0 = unlimited', resolveImitationVoice(getImitationTarget(GROUP))?.remaining === Infinity);
  config.imitate.voiceMaxPerSession = 3;
  setImitationTarget(GROUP, { targetJid: OTHER, label: 'Alice', durationMinutes: 30, useVoice: true });
  check('target without active voice → no voice', resolveImitationVoice(getImitationTarget(GROUP)) === null);

  // ── 5. Prompt assembly ─────────────────────────────────────────────────────
  console.log('\n[prompt]');
  // Spec 007 R8: the base persona's voice/sing manual lives once in the system core.
  const base = buildSystemPrompt(GROUP, true, null);
  check('base persona: VOICE + SING + spoken-register rules', /\[VOICE: /.test(base) && /\[SING: /.test(base) && /TALK in voice notes/.test(base));
  const bundle = buildImitationBundle(GROUP, TARGET, 'Bob', {});
  const noVoice = buildConversationContext(GROUP, null, true, false, bundle).text;
  check('imitating without voice: no VOICE/SING', !/\[VOICE/.test(noVoice) && !/\[SING/.test(noVoice));
  bundle.voice = { voiceId: 'voice_test1', remaining: 2, spokenExemplars: getSpokenExemplars(TARGET, 6, GROUP) };
  const withVoice = buildConversationContext(GROUP, null, true, false, bundle).text;
  check('imitating with voice: VOICE, no SING', /\[VOICE: exactly what Bob says\]/.test(withVoice) && !/\[SING/.test(withVoice));
  check('spoken exemplars included', withVoice.includes('traffic aanu'));
  check('spoken exemplars come from this group (and none without one)',
    getSpokenExemplars(TARGET, 6, GROUP).some(e => e.includes('traffic aanu')) && getSpokenExemplars(TARGET).length === 0);
  check('no-harm line + remaining count', /NEVER use it to ask for money, OTPs/.test(withVoice) && /at most 2 more/.test(withVoice));

  // ── 6. DM enrollment guards ────────────────────────────────────────────────
  console.log('\n[enrollment]');
  const sock = { user: { id: 'bot@s.whatsapp.net' }, signalRepository: {} };
  const dm = (id, text, extra = {}) => ({
    stored: { id, groupJid: TARGET, senderJid: TARGET, messageType: text == null ? 'audio' : 'text', content: text },
    raw: { key: { id }, message: text == null ? { audioMessage: { seconds: 15, ptt: true, ...extra } } : { conversation: text } },
  });
  let d = dm('e0', 'hello there');
  check('ordinary DM not claimed', claimVoiceEnrollment(sock, d.stored, d.raw) === false);
  d = dm('e0b', null);
  check('audio without a session not claimed', claimVoiceEnrollment(sock, d.stored, d.raw) === false);
  setSkillEnabled('imitate-voice', false);
  d = dm('e1', 'voice enroll');
  check('command claimed', claimVoiceEnrollment(sock, d.stored, d.raw) === true);
  await tick();
  check('kill switch off → no session', getEnrollmentSession(TARGET) === null);
  setSkillEnabled('imitate-voice', true);
  d = dm('e2', 'Voice Enroll en');
  claimVoiceEnrollment(sock, d.stored, d.raw);
  await tick();
  check('enroll → sample step, en consent', getEnrollmentSession(TARGET)?.step === 'sample' && getEnrollmentSession(TARGET)?.lang === 'en-US');
  d = dm('e3', null, { contextInfo: { isForwarded: true } });
  check('forwarded note claimed…', claimVoiceEnrollment(sock, d.stored, d.raw) === true);
  await tick();
  check('…but rejected (still at sample)', getEnrollmentSession(TARGET)?.step === 'sample');
  d = dm('e4', null, { ptt: false });
  claimVoiceEnrollment(sock, d.stored, d.raw);
  await tick();
  check('audio file (non-ptt) rejected', getEnrollmentSession(TARGET)?.step === 'sample');
  d = dm('e5', 'voice cancel');
  claimVoiceEnrollment(sock, d.stored, d.raw);
  await tick();
  check('cancel clears session', getEnrollmentSession(TARGET) === null);
  const eve = { stored: { id: 'e6', groupJid: OUTSIDER, senderJid: OUTSIDER, messageType: 'text' }, raw: { key: { id: 'e6' }, message: { conversation: 'voice enroll' } } };
  claimVoiceEnrollment(sock, eve.stored, eve.raw);
  await tick();
  check('non-member cannot enroll', getEnrollmentSession(OUTSIDER) === null);

  d = dm('e7', null);
  d.stored.content = 'Ee shabdathinte udama njananu, oru synthetic voice model srishtikkan';
  storeMessage({ id: 'e7', groupJid: TARGET, senderJid: TARGET, senderName: 'Bob', content: d.stored.content, messageType: 'audio', isFromSelf: false, timestamp: now, metadata: {} });
  check('consent note without a session is claimed (never reaches the LLM)', claimVoiceEnrollment(sock, d.stored, d.raw) === true);
  await tick();

  check('claimed enrollment audio transcript is redacted',
    db.prepare(`SELECT content FROM messages WHERE id = 'e7'`).get()?.content === '[voice enrollment recording]');
  // DM content never feeds a group imitation (text corpus or spoken examples).
  storeMessage({ id: 'dm-audio', groupJid: TARGET, senderJid: TARGET, senderName: 'Bob', content: 'pandu pandoridathu oru private story', messageType: 'audio', isFromSelf: false, timestamp: now + 1, metadata: {} });
  storeMessage({ id: 'dm-text', groupJid: TARGET, senderJid: TARGET, senderName: 'Bob', content: 'voice enroll private dm text', messageType: 'text', isFromSelf: false, timestamp: now + 2, metadata: {} });
  check('spoken examples exclude DMs', !getSpokenExemplars(TARGET, 20, GROUP).some(e => e.includes('private story')));
  const { recallExemplars, resolveAudience } = await import('../src/memory/recall.js');
  const groupCorpus = recallExemplars(resolveAudience({ chatJid: GROUP }), TARGET, { limit: 500 });
  check('text corpus excludes DMs', groupCorpus.length > 0 && !groupCorpus.some(m => m.id === 'dm-text'));

  // Calls: Gemini Live is the only engine; an old CALL_PROVIDER=elevenlabs warns, never crashes.
  {
    const r = spawnSync(process.execPath, ['-e', "import('./src/utils/config.js').then(m => console.log('model=' + m.config.calls.liveModel))"],
      { env: { ...process.env, CALL_PROVIDER: 'elevenlabs' }, encoding: 'utf8' });
    check('CALL_PROVIDER=elevenlabs → a config warning, Gemini Live, no crash',
      r.status === 0 && /CALL_PROVIDER is no longer supported/.test(r.stderr) && /model=gemini/.test(r.stdout));
  }

  // ── 6b. Self-mentions render as "you" ─────────────────────────────────────
  console.log('\n[self mention]');
  const { setSelfIdentity } = await import('../src/utils/selfIdentity.js');
  setSelfIdentity({ id: '155589999999:5@s.whatsapp.net', lid: '111122223333555@lid' });
  storeMessage({ id: 'sm1', groupJid: GROUP, senderJid: OTHER, senderName: 'Alice', content: '@111122223333555 oru voice idd, @111111111111111 nee alla', messageType: 'text', isFromSelf: false, timestamp: now + 5, metadata: {} });
  const selfCtx = buildConversationContext(GROUP, { id: 'sm1' }, true, false, null).text;
  const personaName = (await import('../src/utils/config.js')).getPersona().name;
  check('bot LID mention → "@<name> (you)", others untouched', selfCtx.includes(`@${personaName} (you) oru voice idd, @111111111111111`));

  // ── 7. Cloned-voice quality gate fails closed ──────────────────────────────
  console.log('\n[quality gate]');
  const wasEnabled = config.qualityGate.enabled;
  config.qualityGate.enabled = false;
  check('gate off: normal reply passes', (await evaluateResponse('hi', '', {})).pass === true);
  check('gate off: cloned voice blocked', (await evaluateResponse('hi', '', { clonedVoice: true })).pass === false);
  config.qualityGate.enabled = wasEnabled;

  // ── 8. Audio conversion + input validation ─────────────────────────────────
  console.log('\n[audio]');
  const tone = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 1 << 24 });
  const conv = await toWav24kMono(tone.stdout);
  check('ogg/opus → 24k mono WAV, duration kept', Math.abs(conv.seconds - 12) < 0.3 && conv.wav.subarray(0, 4).toString() === 'RIFF');
  // A streamed WAV has 0xFFFFFFFF size fields, which the voices API rejects with a bare 400.
  check('WAV header sizes are real (not streamed placeholders)',
    conv.wav.readUInt32LE(4) === conv.wav.length - 8 && conv.wav.readUInt32LE(40) === conv.wav.length - 44 && conv.wav.readUInt32LE(24) === 24000);
  const long = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=45', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 1 << 24 });
  check('long sample trimmed to 30s', Math.abs((await toWav24kMono(long.stdout)).seconds - 30) < 0.3);
  // 3 s silence + 20 s tone + 3 s silence → edge silence dropped before the cap.
  const padded = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=3', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=3', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 1 << 24 });
  const trimmed = await toWav24kMono(padded.stdout, { trimSilence: true });
  check(`edge silence trimmed (${trimmed.seconds.toFixed(1)}s of 26s)`, trimmed.seconds > 19 && trimmed.seconds < 21);
  const short = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 1 << 24 });
  let err = null;
  try { await enrollVoice({ personJid: TARGET, sourceAudio: short.stdout, consentAudio: tone.stdout, via: 'test' }); } catch (e) { err = e; }
  check('too-short sample refused before any API call', err instanceof VoiceCloneError && err.code === 'input');

  // ── 8b. Voice delete: revoked at once, Google delete retried; purge ────────
  console.log('\n[voice delete + purge]');
  {
    const vs = await import('../src/memory/voiceStore.js');
    const vc = await import('../src/brain/voiceClone.js');
    const { purgePerson } = await import('../src/memory/relationshipStore.js');
    const DEL = '444444444444444@lid';
    const PURGED = '555555555555555@lid';
    const savedKey = config.llm.geminiApiKey;
    const savedFetch = globalThis.fetch;
    let googleUp = false;
    const deletes = [];
    const failDelete = new Set();   // voice ids whose delete fails even while Google is up
    let created = 0;
    config.llm.geminiApiKey = 'test-gemini-key-not-real';
    globalThis.fetch = async (url, opts = {}) => {
      if (opts.method === 'POST' && String(url).endsWith('/v1beta/voices')) {
        created++;
        return new Response(JSON.stringify({ id: `voice_new${created}` }), { status: 200 });
      }
      if (opts.method !== 'DELETE' || !String(url).includes('/v1beta/voices/')) throw new Error('unexpected fetch in test');
      const id = String(url).split('/').pop();
      deletes.push(id);
      return googleUp && !failDelete.has(id) ? new Response('{}', { status: 200 }) : new Response('down', { status: 503 });
    };
    try {
      savePersonVoice({ personJid: DEL, voiceId: 'voice_del1', via: 'dm', expireTime: now + 86400 });
      const removed = await vc.removeVoice(DEL, { reason: 'dashboard' });
      const row = getPersonVoice(DEL, { includeInactive: true });
      check('removeVoice with Google down: revoked at once, never active', removed === true && getPersonVoice(DEL) === null && !!row?.revoked_at);
      check('…marked Google delete pending for the retry', vs.isVoiceDeletePending(row) && vs.voiceRevokeReason(row) === 'dashboard'
        && vs.listPendingVoiceDeletes().some(r => r.person_jid === DEL));
      googleUp = true;
      const r1 = await vc.retryPendingVoiceDeletes();
      const row2 = getPersonVoice(DEL, { includeInactive: true });
      check('maintenance retry deletes it at Google and clears the mark', r1.deleted === 1 && deletes.filter(d => d === 'voice_del1').length === 2
        && !vs.isVoiceDeletePending(row2) && row2?.revoke_reason === 'dashboard' && !!row2?.revoked_at);

      googleUp = false;
      savePersonVoice({ personJid: PURGED, voiceId: 'voice_purged1', via: 'dashboard', expireTime: now + 86400 });
      const res = purgePerson(PURGED, 'test', 'tester');
      const prow = getPersonVoice(PURGED, { includeInactive: true });
      check('purgePerson revokes the cloned voice inside the purge', res.voicePending === 1 && getPersonVoice(PURGED) === null
        && vs.isVoiceDeletePending(prow) && vs.voiceRevokeReason(prow) === 'purge');
      const r2 = await vc.retryPendingVoiceDeletes({ personJids: [PURGED] });
      check('…a failed Google delete leaves it revoked + pending', r2.failed === 1 && getPersonVoice(PURGED) === null
        && vs.isVoiceDeletePending(getPersonVoice(PURGED, { includeInactive: true })));
      googleUp = true;
      await vc.retryPendingVoiceDeletes();
      check('…once Google confirms, the purged person\'s voice row is gone', getPersonVoice(PURGED, { includeInactive: true }) === null
        && deletes.includes('voice_purged1') && !vs.listPendingVoiceDeletes().length);
      check('purge of someone with no voice: nothing pending', purgePerson(DEL, 'test', 'tester').voicePending === 0
        && getPersonVoice(DEL, { includeInactive: true }) === null);

      // Two identity forms, a voice under each (a merge keeps the merged-away form's
      // row): the person-scoped retry covers both, and one unconfirmed → still pending.
      const { recordIdentity, identitiesOf } = await import('../src/memory/identity.js');
      const TWO = '777777777777777@lid';
      const TWO_PN = '155500000777@s.whatsapp.net';
      recordIdentity(TWO_PN, TWO, 'message');
      savePersonVoice({ personJid: TWO, voiceId: 'voice_two_lid', via: 'dm', expireTime: now + 86400 });
      savePersonVoice({ personJid: TWO_PN, voiceId: 'voice_two_pn', via: 'dm', expireTime: now + 86400 });
      const twoForms = identitiesOf(TWO);
      check('purge of a person with a voice under two forms marks both', purgePerson(TWO, 'test', 'tester').voicePending === 2);
      failDelete.add('voice_two_pn');
      const r3 = await vc.retryPendingVoiceDeletes({ personJids: twoForms });
      check('…the person-scoped retry tries both forms; one unconfirmed → still pending', r3.deleted === 1 && r3.failed === 1 && r3.pending === 1
        && deletes.includes('voice_two_lid') && deletes.includes('voice_two_pn'));
      failDelete.delete('voice_two_pn');
      const r4 = await vc.retryPendingVoiceDeletes({ personJids: twoForms });
      check('…and once confirmed nothing is pending', r4.deleted === 1 && r4.pending === 0);

      // Re-enrolling: the previous voice is deleted at Google BEFORE its row is
      // overwritten; a failed delete refuses the enrollment and keeps the old row.
      const RE = '888888888888888@lid';
      const enroll = () => enrollVoice({ personJid: RE, sourceAudio: tone.stdout, consentAudio: tone.stdout, languageCode: 'en-US', via: 'test' });
      const refused = async () => { try { await enroll(); return null; } catch (e) { return e; } };
      savePersonVoice({ personJid: RE, voiceId: 'voice_re_old', via: 'dm', expireTime: now + 86400 });
      vs.revokePersonVoice(RE, 'dm', { pendingDelete: true });
      googleUp = false;
      const createdBefore = created;
      const e1 = await refused();
      const reRow = getPersonVoice(RE, { includeInactive: true });
      check('re-enroll over a pending delete that fails: refused before any voice is created, mark kept', e1 instanceof VoiceCloneError
        && created === createdBefore && reRow?.voice_id === 'voice_re_old' && vs.isVoiceDeletePending(reRow));
      googleUp = true;
      const ok1 = await enroll();
      check('…once Google deletes it, the enrollment goes through', ok1?.voiceId === `voice_new${created}`
        && getPersonVoice(RE)?.voice_id === ok1.voiceId && deletes.includes('voice_re_old'));
      failDelete.add(ok1.voiceId);
      const e2 = await refused();
      check('re-enroll over an active voice whose delete fails: refused, current voice kept, new voice deleted', e2 instanceof VoiceCloneError
        && getPersonVoice(RE)?.voice_id === ok1.voiceId && deletes.includes(`voice_new${created}`));
      failDelete.delete(ok1.voiceId);
      const ok2 = await enroll();
      check('…and replaces it once the delete works', getPersonVoice(RE)?.voice_id === ok2.voiceId && ok2.voiceId !== ok1.voiceId);
    } finally {
      globalThis.fetch = savedFetch;
      config.llm.geminiApiKey = savedKey;
    }
    check('consent language follows the persona language', vc.defaultConsentLanguage('Manglish') === 'ml-IN'
      && vc.defaultConsentLanguage('Malayalam and English') === 'ml-IN' && vc.defaultConsentLanguage('English') === 'en-US'
      && vc.defaultConsentLanguage('Hindi') === 'en-US' && vc.defaultConsentLanguage('') === 'en-US');
  }

  // ── 9. Live API (optional) ─────────────────────────────────────────────────
  if (LIVE) {
    console.log('\n[live]');
    const v = await generateVoiceNote('ശരി ട്ടോ <laugh>', { ignoreRateLimit: true });
    check(`primary TTS (${v?.model} / ${v?.voice})`, v && v.model === config.voiceNote.model && v.buffer.length > 1000);
    const savedModel = config.voiceNote.model;
    config.voiceNote.model = 'gemini-bogus-tts';
    const fb = await generateVoiceNote('എടാ, ഞാൻ പത്തു മിനിറ്റിൽ എത്തും ട്ടോ', { ignoreRateLimit: true });
    check('bad primary → fallback model', fb?.model === config.voiceNote.fallbackModel);
    config.voiceNote.model = savedModel;
    const cl = await generateVoiceNote('ശരി', { ignoreRateLimit: true, voiceId: 'voice_doesnotexist0' });
    check('failed cloned voice → null (never another voice)', cl === null);
    let cerr = null;
    try { await createReplicatedVoice({ sourceWav: conv.wav, consentWav: conv.wav, displayName: 'test', languageCode: 'ml-IN' }); } catch (e) { cerr = e; }
    if (!(cerr instanceof VoiceCloneError && cerr.code === 'consent')) console.log('    replication probe got:', cerr?.code, cerr?.message?.slice(0, 300));
    // Must reach Google's consent check — a bare 400 means our request/audio format is wrong.
    check('request accepted, tone refused by the consent check', cerr instanceof VoiceCloneError && cerr.code === 'consent');
  }
} finally {
  clearImitationTarget(GROUP);
  closeDb();
  for (const f of ['test-voice.db', 'test-voice.db-wal', 'test-voice.db-shm']) {
    try { fs.unlinkSync(path.join('data', f)); } catch {}
  }
}

// A caller's number: the country code is the install's, never assumed.
{
  const { toE164 } = await import('../src/calls/phoneNumber.js');
  const cases = [
    ['+15550100123', '', '+15550100123'], ['+1 555 010 0123', '', '+15550100123'],
    ['15550100123', '', '+15550100123'], ['5550100123', '', null], ['05550100123', '', null],
    ['5550100123', '1', '+15550100123'], ['05550100123', '1', '+15550100123'],
    ['7700900123', '44', '+447700900123'], ['07700900123', '44', '+447700900123'],
    ['+447700900123', '1', '+447700900123'], ['123', '1', '+123'], ['', '1', null], [null, '', null], ['anonymous', '1', null],
    ['5550100123', 'x1', null], ['5550100123', '12345', null],
  ];
  for (const [raw, code, want] of cases) check(`toE164(${JSON.stringify(raw)}, ${JSON.stringify(code)}) → ${want}`, toE164(raw, code) === want);
}

// The call prompt's language lines: a table now, byte-equal to the code it replaced (sha256 of its output).
{
  const crypto = await import('crypto');
  const { callLanguageLines } = await import('../src/calls/callLanguage.js');
  const sha = (o) => crypto.createHash('sha256').update(`${o.languages}\n${o.languageLine}`).digest('hex').slice(0, 16);
  for (const [persona, want] of [
    [{ language: 'Manglish', region: 'Testville (north)' }, '214c3420c0ae775f'],
    [{ language: 'Malayalam and English', region: 'Testville' }, '214c3420c0ae775f'],
    [{ language: 'malayalam' }, '88494719262022f7'],
    [{ language: 'English', region: 'Testville' }, '0c503ce23a4d4e48'],
    [{ language: 'english' }, '0bec094bbcbd5b16'],
    [{}, '0c503ce23a4d4e48'],
    [{ language: 'Spanish', region: 'Testville, Northshire (the coast)' }, '507b156680feab02'],
    [{ language: 'Hindi and English' }, '0d0c1de4bdbc8c49'],
  ]) check(`call language lines byte-equal: ${persona.language ?? 'no language'}`, sha(callLanguageLines(persona)) === want, sha(callLanguageLines(persona)));
  check('an English persona gets no pinned language', !/Speak /.test(callLanguageLines({ language: 'English' }).languageLine));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll voice checks passed');
process.exit(failures ? 1 : 0);
