import { getDb } from '../../memory/db.js';
import { getAllGroups, getGroup, getMembers, getTopSlang, updateVibe, setOwnerGroupField, releaseOwnerGroupField, groupFieldSources } from '../../memory/groupStore.js';
import { getActiveBill } from '../../memory/billStore.js';
import { getRecentMessages, getRecentMessagesForPrompt } from '../../memory/messageStore.js';
import { getAllMemoriesForGroup, getAllGroupRelationships } from '../../memory/relationshipStore.js';
import { isFresh } from '../../memory/membership.js';
import { withProvenance } from './memories.js';
import { muteGroup, unmuteGroup, isGroupMuted } from '../state.js';
import { setImitationTarget, clearImitationTarget, getImitationTarget, setImitationVoice, resolveImitationVoice, recordImitationVoiceNote } from '../../behavior/imitationState.js';
import { evaluateResponse } from '../../brain/qualityGate.js';
import { flattenContent } from '../../utils/transcript.js';
import { getPersonVoice } from '../../memory/voiceStore.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { getActivePeopleInGroup, getGroupNicknames } from '../../memory/peopleStore.js';
import { resolveAudience, recallExemplars, recallNicknames } from '../../memory/recall.js';
import { resolvePerson } from '../../memory/identity.js';
import { buildVoiceDescriptor, buildImitationBundle, getSpokenExemplars } from '../../personality/styleProfiler.js';
import { checkWarmup } from '../../behavior/warmup.js';
import { auditWrite } from '../audit.js';
import { config, getProviderKey } from '../../utils/config.js';
import { generateResponse } from '../../brain/contextBuilder.js';
import { postProcess } from '../../brain/postProcess.js';
import { sendText, sendSticker, sendGif, sendVoiceNote } from '../../whatsapp/actions.js';
import { generateVoiceNote, extractVoiceMarker, extractSingMarker, SPEECH_TAG_RE } from '../../brain/voiceGen.js';
import { searchGiphy, pickContextualQuery } from '../../brain/mediaSearch.js';
import { logger } from '../../utils/logger.js';
import { actorOf } from '../auth.js';

const OWNER_FIELDS = ['vibe', 'language'];
const VIBE_MAX = 500;
const LANGUAGE_MAX = 40;

export default async function groupsRoutes(app, opts = {}) {
  const getSock = opts.getSock || (() => null);

  app.get('/api/groups', async () => {
    const groups = getAllGroups();
    const db = getDb();
    const since30d = Math.floor(Date.now() / 1000) - 30 * 86400;
    const count30d = db.prepare('SELECT COUNT(*) as c FROM messages WHERE group_jid = ? AND timestamp >= ?');
    return groups.map(g => {
      // MSG·30D on the Groups page: stored messages of the last 30 days.
      const msgCount = count30d.get(g.jid, since30d).c;
      const memberCount = db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_jid = ?').get(g.jid).c;
      return {
        jid: g.jid,
        name: g.name,
        vibe: g.vibe,
        language: g.language,
        avgMessagesHr: g.avg_messages_hr,
        lastActive: g.last_active,
        joinedAt: g.joined_at,
        messageCount: msgCount,
        memberCount,
        muted: isGroupMuted(g.jid),
      };
    });
  });

  app.get('/api/groups/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    const db = getDb();
    // Each member's summary as learned in THIS group (operator view; the owner facet
    // and other chats' facets are on the person page).
    const facetSummary = db.prepare(`SELECT summary FROM person_facets WHERE person_jid = ? AND origin_jid = ?`).pluck();
    const members = getMembers(jid).map(m => ({ ...m, summary: facetSummary.get(m.person_jid, jid) || null }));
    // This chat's own terms plus global ones, each tagged with where it was heard.
    const slang = withProvenance(getTopSlang(jid, 30));
    const activeBill = getActiveBill(jid);
    const recent = getRecentMessages(jid, 50);
    const memories = withProvenance(getAllMemoriesForGroup(jid, 20), { audience: true, derivedType: 'memory' });
    const nicknames = withProvenance(getGroupNicknames(jid));
    const relationships = withProvenance(getAllGroupRelationships(jid));
    let fresh = false;
    try { fresh = isFresh(jid); } catch { fresh = false; }

    return {
      ...group,
      // 'owner' = set on this page (learning leaves it alone); else learned / default.
      field_sources: groupFieldSources(group),
      muted: isGroupMuted(group.jid),
      members_synced_at: group.members_synced_at ?? null,
      member_count_synced: members.length,
      membership_fresh: fresh,
      imitation: (() => {
        const t = getImitationTarget(jid);
        if (!t) return null;
        // Voice status for the imitate panel: is the target enrolled, is the
        // global kill switch on, how much of the per-session cap is used.
        return {
          ...t,
          voiceEnrolled: !!getPersonVoice(t.targetJid),
          voiceSkillEnabled: isSkillEnabled('imitate-voice'),
          voiceMaxPerSession: config.imitate.voiceMaxPerSession,
        };
      })(),
      imitateMinCorpus: config.imitate.minCorpus,
      // Live reply model, not a build-time snapshot — makes a weird imitation
      // diagnosable as a provider outage rather than a bad style profile.
      activeGenerationModel: `${config.llm.provider}/${config.llm.model}`,
      // Warmup gates text before generation runs — surfaced so the Imitate card
      // can warn that imitation is inert on a warming deployment.
      warmupBlocksText: !checkWarmup('text').allowed,
      members,
      slang,
      activeBill,
      recentMessages: recent,
      memories,
      nicknames,
      relationships,
    };
  });

  // Owner edits of vibe / language. A value the owner saves is marked as theirs and
  // batch learning leaves it alone; `release: ['vibe'|'language']` (or saving an
  // empty box) hands the field back to learning.
  app.patch('/api/groups/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const body = req.body || {};
    if (!getGroup(jid)) { reply.code(404).send({ error: 'Group not found' }); return; }
    const release = body.release === undefined ? [] : body.release;
    if (!Array.isArray(release) || release.some(f => !OWNER_FIELDS.includes(f))) {
      reply.code(400).send({ error: 'release must be a list of: vibe, language' });
      return;
    }
    for (const [field, max] of [['vibe', VIBE_MAX], ['language', LANGUAGE_MAX]]) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].trim().length > max)) {
        reply.code(400).send({ error: `${field} must be a string of at most ${max} characters` });
        return;
      }
    }
    const changes = {};
    const released = new Set(release);
    for (const field of OWNER_FIELDS) {
      if (typeof body[field] !== 'string' || released.has(field)) continue;
      const value = body[field].trim();
      if (!value) { released.add(field); continue; }
      setOwnerGroupField(jid, field, value);
      changes[field] = value;
    }
    for (const field of released) {
      if (field === 'vibe' && typeof body.vibe === 'string' && !body.vibe.trim()) updateVibe(jid, null);
      releaseOwnerGroupField(jid, field);
    }
    if (released.size) changes.released = [...released];
    if (!Object.keys(changes).length) {
      reply.code(400).send({ error: 'No known fields to update (vibe, language, release)' });
      return;
    }
    auditWrite(actorOf(req), 'group.patch', jid, changes);
    return { ok: true, changes, sources: groupFieldSources(getGroup(jid)) };
  });

  app.post('/api/groups/:jid/mute', async (req, reply) => {
    const jid = req.params.jid;
    if (!getGroup(jid)) { reply.code(404).send({ error: 'Group not found' }); return; }
    const { durationMinutes = null, reason = null } = req.body || {};
    // null/absent = until unmuted; anything else must be a positive number of minutes
    // (a NaN would otherwise read as "no duration" = an indefinite mute).
    const dur = durationMinutes == null || durationMinutes === '' ? null : Number(durationMinutes);
    if (dur !== null && !(Number.isFinite(dur) && dur > 0)) {
      reply.code(400).send({ error: 'durationMinutes must be a positive number (or omitted for an indefinite mute)' });
      return;
    }
    const result = muteGroup(jid, { durationMinutes: dur, reason });
    auditWrite(actorOf(req), 'group.mute', jid, { durationMinutes: dur, reason });
    return { ok: true, ...result };
  });

  app.post('/api/groups/:jid/unmute', async (req) => {
    const jid = req.params.jid;
    const ok = unmuteGroup(jid);
    auditWrite(actorOf(req), 'group.unmute', jid, {});
    return { ok };
  });

  // ── Imitate mode (per-group target; global master switch = the 'imitate' skill) ──

  app.post('/api/groups/:jid/imitate', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    const { targetJid, durationMinutes = null, reason = null } = req.body || {};
    if (!targetJid || typeof targetJid !== 'string') {
      reply.code(400).send({ error: 'targetJid required' });
      return;
    }

    // (1) Membership — single source of truth is group_members: you can only
    // imitate someone who is currently in this room.
    const member = getActivePeopleInGroup(jid).find(p => p.jid === targetJid);
    if (!member) {
      reply.code(400).send({ error: 'Target is not a current member of this group' });
      return;
    }

    // (2) Corpus floor — refuse a low-fidelity caricature of a light poster. Counted
    // from the same source the runtime imitates from: this group's own messages by
    // the target, over all their JID forms (R13 — never other groups or DMs).
    const groupAudience = resolveAudience({ chatJid: jid });
    const totalCount = recallExemplars(groupAudience, targetJid, { limit: config.imitate.minCorpus }).length;
    if (totalCount < config.imitate.minCorpus) {
      reply.code(400).send({ error: `Not enough of their messages in this group to imitate (${totalCount}/${config.imitate.minCorpus})` });
      return;
    }

    // Auto-expiry is mandatory — clamp to the configured ceiling; blank = ceiling.
    const requested = Number(durationMinutes);
    const dur = Math.min(
      Number.isFinite(requested) && requested > 0 ? Math.round(requested) : config.imitate.maxDurationMinutes,
      config.imitate.maxDurationMinutes,
    );

    // Label priority mirrors the transcript's baseLabelForJid (systemPrompt.js)
    // so the imitated name matches how this person is already rendered.
    // Only a name this group may see (the prompts' own visibility rule): the label is
    // posted in the chat, so a nickname learned in a DM or another group must not surface.
    const visibleNicks = recallNicknames(groupAudience, [targetJid]).get(resolvePerson(targetJid) || targetJid) || [];
    const nick = visibleNicks.find(n => n.source === 'self_declared' && n.confidence >= 0.5);
    const phoneDigits = member.phone ? String(member.phone).replace(/\D/g, '') : '';
    const label = nick?.nickname || member.push_name || member.real_name
      || (phoneDigits ? `@${phoneDigits.slice(-4)}` : 'them');

    const actor = actorOf(req);
    // Cloned voice only if the target has enrolled one themselves.
    const useVoice = req.body?.useVoice === true && !!getPersonVoice(targetJid);
    const result = setImitationTarget(jid, { targetJid, label, durationMinutes: dur, enabledBy: actor, reason, useVoice });
    auditWrite(actor, 'imitate.on', jid, { targetJid, label, durationMinutes: dur, activeUntil: result.activeUntil, reason, useVoice });

    // Optional LLM voice descriptor — fire-and-forget so the route stays fast;
    // imitation works without it (few-shot exemplars are the primary engine).
    buildVoiceDescriptor(jid, targetJid, label).catch(err => {
      logger.debug({ err: err.message, targetJid }, 'Voice descriptor build failed (non-critical)');
    });

    // Optional in-chat disclosure. Goes through actions.sendText → honors DRY_RUN.
    if (config.imitate.disclose) {
      const sock = getSock();
      if (sock) {
        const voiceNote = useVoice ? ` (any voice notes from me meanwhile are an AI copy of ${label}'s voice 🎙️)` : '';
        sendText(sock, jid, `fyi: i'll be channeling ${label} for a bit 🎭${voiceNote}`).catch(err => {
          logger.debug({ err: err.message, jid }, 'Imitation disclosure send failed (non-critical)');
        });
      }
    }

    return { ok: true, targetJid, label, activeUntil: result.activeUntil, corpus: totalCount, warmupBlocksText: !checkWarmup('text').allowed };
  });

  // Toggle cloned-voice notes for the ACTIVE imitation. Requires the target to have
  // enrolled a voice (their own sample + consent recording).
  app.post('/api/groups/:jid/imitate/voice', async (req, reply) => {
    const jid = req.params.jid;
    const active = getImitationTarget(jid);
    if (!active) { reply.code(400).send({ error: 'No active imitation in this group' }); return; }
    const useVoice = req.body?.useVoice === true;
    if (useVoice && !getPersonVoice(active.targetJid)) {
      reply.code(400).send({ error: `${active.label || 'The target'} has no enrolled voice — they must DM the bot "voice enroll", or upload their recordings on their person page` });
      return;
    }
    setImitationVoice(jid, useVoice);
    auditWrite(actorOf(req), useVoice ? 'imitate.voice.on' : 'imitate.voice.off', jid, { targetJid: active.targetJid });
    if (useVoice && config.imitate.disclose) {
      const sock = getSock();
      if (sock) {
        sendText(sock, jid, `fyi: voice notes from me for a bit are an AI copy of ${active.label}'s voice 🎙️`).catch(err => {
          logger.debug({ err: err.message, jid }, 'Imitation voice disclosure send failed (non-critical)');
        });
      }
    }
    return { ok: true, useVoice, skillEnabled: isSkillEnabled('imitate-voice') };
  });

  app.post('/api/groups/:jid/imitate/off', async (req) => {
    const jid = req.params.jid;
    const ok = clearImitationTarget(jid);
    auditWrite(actorOf(req), 'imitate.off', jid, {});
    return { ok };
  });

  // Rebuild the persisted LLM voice descriptor for the active target (or an
  // explicit targetJid). Awaited — the caller wants to know it worked.
  app.post('/api/groups/:jid/imitate/rebuild-card', async (req, reply) => {
    const jid = req.params.jid;
    const active = getImitationTarget(jid);
    const targetJid = (typeof req.body?.targetJid === 'string' && req.body.targetJid) || active?.targetJid;
    if (!targetJid) {
      reply.code(400).send({ error: 'No active imitation target — pass targetJid explicitly' });
      return;
    }
    const member = getActivePeopleInGroup(jid).find(p => p.jid === targetJid);
    if (!member) {
      reply.code(400).send({ error: 'Target is not a current member of this group' });
      return;
    }
    const label = active?.label || member.push_name || member.real_name || 'them';
    const descriptor = await buildVoiceDescriptor(jid, targetJid, label);
    auditWrite(actorOf(req), 'imitate.rebuild_card', jid, { targetJid, built: !!descriptor });
    if (!descriptor) {
      reply.code(422).send({ error: 'Descriptor build failed (thin corpus or LLM unavailable)' });
      return;
    }
    return { ok: true, targetJid, model: `${config.llm.provider}/${config.llm.model}` };
  });

  // Force a one-off reply in a group, bypassing mute/warmup/rate-limit/decision-engine.
  app.post('/api/groups/:jid/respond', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    const sock = getSock();
    if (!sock) { reply.code(503).send({ error: 'Bot socket not connected' }); return; }

    const recent = getRecentMessagesForPrompt(jid, 1);
    if (!recent.length) { reply.code(400).send({ error: 'No messages in this group yet' }); return; }
    const latest = recent[recent.length - 1];

    const triggerMsg = {
      id: latest.id,
      groupJid: latest.group_jid,
      senderJid: latest.sender_jid,
      senderName: latest.sender_name,
      content: latest.content,
    };

    const override = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const startTime = Date.now();
    let textToSend = override;

    if (!textToSend) {
      // allowWeb:false — a dashboard force-send must stay fast and never launch the
      // headless browser / run the web loop from a request thread.
      const llmResult = await generateResponse(triggerMsg, { isGroup: true, isDm: false }, { allowWeb: false, forceReply: 'Plain text only — no [VOICE]/[IMAGE]/[STICKER]/[GIF] markers.' });
      if (!llmResult) {
        reply.code(422).send({ error: 'LLM returned nothing (check logs). Retry, or send {"text":"..."} to force exact text.' });
        return;
      }
      const processed = postProcess(llmResult.text, llmResult.fixatedWords, { isGroup: true });
      textToSend = processed?.text || null;
    }

    if (!textToSend) {
      reply.code(422).send({ error: 'Generated reply was empty after post-processing' });
      return;
    }

    try {
      await sendText(sock, jid, textToSend);
    } catch (err) {
      logger.error({ err: err.message, jid }, 'Force-respond send failed');
      reply.code(500).send({ error: 'Send failed', detail: err.message });
      return;
    }

    const elapsed = Date.now() - startTime;
    try {
      getDb().prepare(
        `INSERT INTO response_log (message_id, group_jid, score, decided, factors_json, response_time_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
      ).run(latest.id, jid, null, 'text', JSON.stringify({ forced: true, source: 'dashboard', overridden: !!override }), elapsed);
    } catch (err) {
      logger.warn({ err: err.message }, 'Force-respond response_log insert failed');
    }

    auditWrite(
      actorOf(req),
      'group.force_respond',
      jid,
      { textPreview: textToSend.slice(0, 120), overridden: !!override }
    );

    return { ok: true, text: textToSend, elapsedMs: elapsed };
  });

  // Force-send a contextually-picked sticker or GIF.
  // Routed by `kind` so a single handler covers both endpoints.
  async function handleForceMedia(kind, req, reply) {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    if (!config.media.giphyApiKey) {
      reply.code(503).send({ error: 'GIPHY_API_KEY not configured' });
      return;
    }

    const sock = getSock();
    if (!sock) { reply.code(503).send({ error: 'Bot socket not connected' }); return; }

    const recent = getRecentMessagesForPrompt(jid, 20).filter(m => !m.is_from_self);
    if (!recent.length) {
      reply.code(400).send({ error: 'No messages from others in this group yet' });
      return;
    }
    const ctx = recent.slice(-15);

    const startTime = Date.now();
    const query = await pickContextualQuery(ctx, kind);
    if (!query) {
      reply.code(422).send({ error: 'Could not derive a search query from recent messages' });
      return;
    }

    const media = await searchGiphy(query, kind, { ignoreRateLimit: true });
    if (!media) {
      reply.code(422).send({ error: 'No matching media found', query });
      return;
    }

    try {
      if (kind === 'sticker') {
        await sendSticker(sock, jid, media.buffer);
      } else {
        await sendGif(sock, jid, media.buffer, '');
      }
    } catch (err) {
      logger.error({ err: err.message, jid, kind }, 'Force-media send failed');
      reply.code(500).send({ error: 'Send failed', detail: err.message });
      return;
    }

    const elapsed = Date.now() - startTime;
    const triggerId = ctx[ctx.length - 1].id;
    try {
      getDb().prepare(
        `INSERT INTO response_log (message_id, group_jid, score, decided, factors_json, response_time_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
      ).run(triggerId, jid, null, kind, JSON.stringify({ forced: true, source: 'dashboard', query, giphyId: media.id }), elapsed);
    } catch (err) {
      logger.warn({ err: err.message }, 'Force-media response_log insert failed');
    }

    auditWrite(
      actorOf(req),
      kind === 'sticker' ? 'media.send_sticker_dashboard' : 'media.send_gif_dashboard',
      jid,
      { query, giphyId: media.id }
    );

    return { ok: true, query, giphyId: media.id, elapsedMs: elapsed };
  }

  app.post('/api/groups/:jid/send-sticker', (req, reply) => handleForceMedia('sticker', req, reply));
  app.post('/api/groups/:jid/send-gif',     (req, reply) => handleForceMedia('gif', req, reply));

  // Force-send a voice note (TTS). Mirrors /respond — speaks operator-provided text, or an
  // LLM-generated contextual reply when no text is given — via Gemini TTS. `sing:true` uses
  // the singing path. Bypasses mute/warmup/rate-limit like the other force-send endpoints.
  app.post('/api/groups/:jid/send-voice', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    if (!config.voiceNote.enabled) {
      reply.code(503).send({ error: 'Voice notes disabled (VOICE_NOTE_ENABLED=false)' });
      return;
    }
    if (!getProviderKey('gemini')) {
      reply.code(503).send({ error: 'No Gemini API key configured for TTS' });
      return;
    }

    const sock = getSock();
    if (!sock) { reply.code(503).send({ error: 'Bot socket not connected' }); return; }

    const recent = getRecentMessagesForPrompt(jid, 1);
    if (!recent.length) { reply.code(400).send({ error: 'No messages in this group yet' }); return; }
    const latest = recent[recent.length - 1];

    const sing = req.body?.sing === true;
    const override = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const startTime = Date.now();
    let speechText = override;

    const triggerMsg = {
      id: latest.id,
      groupJid: latest.group_jid,
      senderJid: latest.sender_jid,
      senderName: latest.sender_name,
      content: latest.content,
    };

    // While this group imitates someone with their enrolled voice switched on, the
    // forced note is theirs: written as them, spoken in their cloned voice, and held
    // to the same fail-closed cloned-voice gate as organic notes (typed text too).
    let imitation = null;
    const target = isSkillEnabled('imitate') ? getImitationTarget(jid) : null;
    const cloned = target ? resolveImitationVoice(target) : null;
    if (cloned) {
      if (sing) {
        reply.code(400).send({ error: `Singing isn't available in a cloned voice — untick SING to send a voice note as ${target.label}` });
        return;
      }
      imitation = buildImitationBundle(jid, target.targetJid, target.label, { topicHint: latest.content });
      if (!imitation) {
        reply.code(422).send({ error: `Not enough of ${target.label}'s messages to imitate right now` });
        return;
      }
      imitation.enabledAt = target.enabledAt || null;
      imitation.speakerIsTarget = target.targetJid === latest.sender_jid;
      imitation.voice = { ...cloned, spokenExemplars: getSpokenExemplars(target.targetJid, 6, jid) };
    }

    if (!speechText) {
      // allowWeb:false — keep the request thread fast; never launch the headless browser.
      const llmResult = await generateResponse(triggerMsg, { isGroup: true, isDm: false, imitation }, {
        allowWeb: false,
        forceReply: sing
          ? 'Reply with ONLY [SING: 2-4 lines of lyrics] fitting the moment.'
          : 'Reply with ONLY [VOICE: what you say out loud] — a short voice note, written as spoken words.',
      });
      if (!llmResult) {
        reply.code(422).send({ error: 'LLM returned nothing (check logs). Retry, or send {"text":"..."} to speak exact text.' });
        return;
      }
      // Prefer the marker's spoken text; the caption / plain text is the fallback.
      // Never speak raw markers.
      const marked = sing ? extractSingMarker(llmResult.text) : extractVoiceMarker(llmResult.text);
      const processed = postProcess(marked?.text || llmResult.text, llmResult.fixatedWords, { isGroup: true });
      speechText = marked?.text?.trim() || processed?.text || '';
    }

    if (!speechText) {
      reply.code(422).send({ error: 'Nothing to speak after post-processing' });
      return;
    }

    if (cloned) {
      const recentForGate = getRecentMessagesForPrompt(jid, 5)
        .filter(m => !m.is_from_self)
        .map(m => `[${m.sender_name || 'Unknown'}]: ${flattenContent(m.content, m.message_type)}`)
        .join('\n');
      const gate = await evaluateResponse(speechText.replace(SPEECH_TAG_RE, ''), recentForGate, { isMention: true, imitate: true, clonedVoice: true });
      if (!gate.pass) {
        auditWrite(actorOf(req), 'media.send_voice_dashboard.blocked', jid,
          { clonedVoiceOf: target.targetJid, textPreview: speechText.slice(0, 120), reason: gate.reason });
        reply.code(422).send({ error: `Blocked by the cloned-voice check (${gate.reason || 'low score'}) — nothing was sent`, text: speechText });
        return;
      }
    }

    const voice = await generateVoiceNote(speechText, { sing, ignoreRateLimit: true, voiceId: cloned?.voiceId || null });
    if (!voice) {
      reply.code(422).send({ error: 'Voice generation failed (check GEMINI_API_KEY, voice model, and ffmpeg)' });
      return;
    }

    try {
      await sendVoiceNote(sock, jid, voice.buffer, voice.duration, null, { waveform: voice.waveform, transcript: speechText });
      if (cloned) recordImitationVoiceNote(jid);
    } catch (err) {
      logger.error({ err: err.message, jid }, 'Force-voice send failed');
      reply.code(500).send({ error: 'Send failed', detail: err.message });
      return;
    }

    const elapsed = Date.now() - startTime;
    try {
      getDb().prepare(
        `INSERT INTO response_log (message_id, group_jid, score, decided, factors_json, response_time_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
      ).run(latest.id, jid, null, sing ? 'sing' : 'voice', JSON.stringify({ forced: true, source: 'dashboard', overridden: !!override, sing }), elapsed);
    } catch (err) {
      logger.warn({ err: err.message }, 'Force-voice response_log insert failed');
    }

    auditWrite(
      actorOf(req),
      'media.send_voice_dashboard',
      jid,
      { textPreview: speechText.slice(0, 120), sing, overridden: !!override, duration: voice.duration, clonedVoiceOf: cloned ? target.targetJid : undefined }
    );

    return { ok: true, text: speechText, duration: voice.duration, sing, elapsedMs: elapsed, clonedVoiceOf: cloned ? target.label : null };
  });
}
