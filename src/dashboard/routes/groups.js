import { getDb } from '../../memory/db.js';
import { getAllGroups, getGroup, getMembers, getTopSlang, getActiveTopics, updateVibe, updateLanguage } from '../../memory/groupStore.js';
import { getActiveBill } from '../../memory/billStore.js';
import { getRecentMessages } from '../../memory/messageStore.js';
import { getMemoriesForGroup } from '../../memory/relationshipStore.js';
import { muteGroup, unmuteGroup, listMutedGroups, isGroupMuted } from '../state.js';
import { auditWrite } from '../audit.js';
import { config } from '../../utils/config.js';
import { generateResponse } from '../../brain/contextBuilder.js';
import { postProcess } from '../../brain/postProcess.js';
import { sendText, sendSticker, sendGif } from '../../whatsapp/actions.js';
import { searchGiphy, pickContextualQuery } from '../../brain/mediaSearch.js';
import { logger } from '../../utils/logger.js';

export default async function groupsRoutes(app, opts = {}) {
  const getSock = opts.getSock || (() => null);

  app.get('/api/groups', async () => {
    const groups = getAllGroups();
    const db = getDb();
    return groups.map(g => {
      const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE group_jid = ?').get(g.jid).c;
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

  app.get('/api/groups/muted', async () => listMutedGroups());

  app.get('/api/groups/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    const members = getMembers(jid);
    const slang = getTopSlang(jid, 30);
    const topics = getActiveTopics(jid, 10);
    const activeBill = getActiveBill(jid);
    const recent = getRecentMessages(jid, 50);
    const memories = getMemoriesForGroup(jid, 20);

    return {
      ...group,
      muted: isGroupMuted(group.jid),
      members,
      slang,
      topics,
      activeBill,
      recentMessages: recent,
      memories,
    };
  });

  app.patch('/api/groups/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const body = req.body || {};
    const changes = {};
    if (typeof body.vibe === 'string') {
      updateVibe(jid, body.vibe);
      changes.vibe = body.vibe;
    }
    if (typeof body.language === 'string') {
      updateLanguage(jid, body.language);
      changes.language = body.language;
    }
    if (!Object.keys(changes).length) {
      reply.code(400).send({ error: 'No known fields to update (vibe, language)' });
      return;
    }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'group.patch', jid, changes);
    return { ok: true, changes };
  });

  app.post('/api/groups/:jid/mute', async (req) => {
    const jid = req.params.jid;
    const { durationMinutes = null, reason = null } = req.body || {};
    const dur = durationMinutes == null ? null : Number(durationMinutes);
    const result = muteGroup(jid, { durationMinutes: dur, reason });
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'group.mute', jid, { durationMinutes: dur, reason });
    return { ok: true, ...result };
  });

  app.post('/api/groups/:jid/unmute', async (req) => {
    const jid = req.params.jid;
    const ok = unmuteGroup(jid);
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'group.unmute', jid, {});
    return { ok };
  });

  // Force a one-off reply in a group, bypassing mute/warmup/rate-limit/decision-engine.
  app.post('/api/groups/:jid/respond', async (req, reply) => {
    const jid = req.params.jid;
    const group = getGroup(jid);
    if (!group) { reply.code(404).send({ error: 'Group not found' }); return; }

    const sock = getSock();
    if (!sock) { reply.code(503).send({ error: 'Bot socket not connected' }); return; }

    const recent = getRecentMessages(jid, 1);
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
      const llmResult = await generateResponse(triggerMsg, { isGroup: true, isDm: false });
      if (!llmResult) {
        reply.code(422).send({ error: 'LLM declined to respond. Retry with {"text":"..."} to force.' });
        return;
      }
      const processed = postProcess(llmResult.text, llmResult.fixatedWords, { isGroup: true });
      textToSend = processed?.text || llmResult.text;
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
      req.basicAuthUser?.username || config.dashboard.user,
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

    const recent = getRecentMessages(jid, 20).filter(m => !m.is_from_self);
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
      req.basicAuthUser?.username || config.dashboard.user,
      kind === 'sticker' ? 'media.send_sticker_dashboard' : 'media.send_gif_dashboard',
      jid,
      { query, giphyId: media.id }
    );

    return { ok: true, query, giphyId: media.id, elapsedMs: elapsed };
  }

  app.post('/api/groups/:jid/send-sticker', (req, reply) => handleForceMedia('sticker', req, reply));
  app.post('/api/groups/:jid/send-gif',     (req, reply) => handleForceMedia('gif', req, reply));
}
