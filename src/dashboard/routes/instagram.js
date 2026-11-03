import fs from 'fs';
import path from 'path';
import { auditWrite } from '../audit.js';
import { config } from '../../utils/config.js';
import { onDashboardEvent } from '../events.js';
import { registerTopic } from '../sse.js';
import * as store from '../../memory/igStore.js';
import { status as deviceStatus, recentCommands } from '../../instagram/device.js';
import {
  startSession, stopSession, instagramState, clearAlert, shareFromQueue, vetoReel, setShareCaption,
  dailyCounts, warmupState, SessionError,
} from '../../instagram/session.js';
import { schedulePlan } from '../../instagram/scheduler.js';
import { checkChat, chatState } from '../../instagram/chat.js';
import { getPerson } from '../../memory/peopleStore.js';
import { getTaste, writeTaste } from '../../instagram/taste.js';
import { toTypeable } from '../../instagram/caption.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { actorOf } from '../auth.js';

const THUMB_DIR = path.join(config.projectRoot, 'data', 'instagram', 'thumbs');

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function publicReel(r) {
  return {
    id: r.id, sessionId: r.session_id, account: r.account, caption: r.caption, likeCount: r.like_count,
    description: r.description, depth: r.description_depth, language: r.language, humourType: r.humour_type,
    dwellMs: r.dwell_ms, jevModel: r.jev_model, jevAnswers: parseJson(r.jev_answers),
    humour: r.humour, fit: r.fit, confidence: r.confidence, hazards: parseJson(r.hazards) || [],
    forWhom: r.for_whom, action: r.action, reason: r.reason, liked: !!r.liked, saved: !!r.saved,
    shareState: r.share_state, shareCaption: r.share_caption, shareError: r.share_error, sharedAt: r.shared_at,
    approvedBy: r.approved_by, userLabel: r.user_label, hasThumb: !!r.thumb_path, costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}


function fail(reply, err) {
  reply.code(err instanceof SessionError ? err.status : 500).send({ error: err.message });
}

export default async function instagramRoutes(app) {
  // Device card + live session + today's counts + schedule.
  app.get('/api/instagram/status', async () => {
    const since = Math.floor(Date.now() / 1000) - 86400;
    return {
      enabled: isSkillEnabled('instagram-reels'),
      device: await deviceStatus(),
      ...instagramState(),
      today: dailyCounts(),
      last24h: store.reelStats(since),
      warmup: warmupState(),
      schedule: schedulePlan(),
      groupName: config.instagram.groupName,
      timezone: config.timezone,
      dryRun: config.dryRun,
      settings: {
        approvalMode: config.instagram.approvalMode, likesPerDay: config.instagram.likesPerDay,
        sharesPerDay: config.instagram.sharesPerDay, sessionsPerDay: config.instagram.sessionsPerDay,
      },
      sessions: store.listSessions(10),
    };
  });

  app.get('/api/instagram/reels', async (req) => {
    const q = req.query || {};
    return store.listReels({
      action: ['skip', 'like', 'like_and_queue'].includes(q.action) ? q.action : undefined,
      sessionId: q.session ? Number(q.session) : undefined,
      q: q.q ? String(q.q).slice(0, 200) : undefined,
      limit: Math.min(parseInt(q.limit || '50', 10) || 50, 200),
      beforeId: q.before ? Number(q.before) : undefined,
    }).map(publicReel);
  });

  app.get('/api/instagram/reels/:id/thumb', async (req, reply) => {
    const r = store.getReel(Number(req.params.id));
    const file = r?.thumb_path && path.resolve(r.thumb_path);
    if (!file || !file.startsWith(THUMB_DIR + path.sep) || !fs.existsSync(file)) { reply.code(404).send({ error: 'no thumbnail' }); return; }
    reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(fs.readFileSync(file));
  });

  // Your verdict on Jev's call: 1 good, -1 bad, 0 clear. Used to tune thresholds.
  app.post('/api/instagram/reels/:id/label', async (req, reply) => {
    const id = Number(req.params.id);
    const label = Number(req.body?.label);
    if (![1, -1, 0].includes(label) || !store.getReel(id)) { reply.code(400).send({ error: 'label must be 1, -1 or 0 on an existing reel' }); return; }
    store.labelReel(id, label || null);
    auditWrite(actorOf(req), 'instagram.label', String(id), { label: label || null });
    return { ok: true };
  });

  app.get('/api/instagram/queue', async () => store.listQueue().map(publicReel));

  // Approve = share it now (finds it in Instagram's Saved list). Optional caption edit.
  app.post('/api/instagram/queue/:id/approve', async (req, reply) => {
    const id = Number(req.params.id);
    const actor = actorOf(req);
    try {
      const caption = typeof req.body?.caption === 'string' ? toTypeable(req.body.caption) : undefined;
      const res = await shareFromQueue(id, {
        actor, caption,
        onApproved: () => auditWrite(actor, 'instagram.approve', String(id), { caption: req.body?.caption ?? null }),
      });
      return { ok: true, ...res };
    } catch (err) { fail(reply, err); }
  });

  app.post('/api/instagram/queue/:id/veto', async (req, reply) => {
    try {
      vetoReel(Number(req.params.id), actorOf(req));
      auditWrite(actorOf(req), 'instagram.veto', String(req.params.id), {});
      return { ok: true };
    } catch (err) { fail(reply, err); }
  });

  app.post('/api/instagram/queue/:id/caption', async (req, reply) => {
    if (typeof req.body?.caption !== 'string') { reply.code(400).send({ error: 'caption required' }); return; }
    try {
      const caption = toTypeable(req.body.caption);
      setShareCaption(Number(req.params.id), caption);
      auditWrite(actorOf(req), 'instagram.caption', String(req.params.id), { caption });
      return { ok: true, caption };
    } catch (err) { fail(reply, err); }
  });

  // Manual browse. Skips the schedule and active hours; never the daily caps, warmup
  // (allowShare only lifts "manual sessions don't share", inSessionShareGate), an open
  // alert, a running session or a missing phone.
  app.post('/api/instagram/browse', async (req, reply) => {
    const minutes = Number(req.body?.minutes);
    if (![5, 10, 15].includes(minutes)) { reply.code(400).send({ error: 'minutes must be 5, 10 or 15' }); return; }
    const allowShare = req.body?.allowShare === true;
    try {
      const id = startSession({ trigger: 'manual', minutes, allowShare, actor: actorOf(req) });
      auditWrite(actorOf(req), 'instagram.browse', String(id), { minutes, allowShare });
      return { ok: true, sessionId: id };
    } catch (err) { fail(reply, err); }
  });

  app.post('/api/instagram/stop', async (req) => {
    const ok = stopSession();
    if (ok) auditWrite(actorOf(req), 'instagram.stop', null, {});
    return { ok };
  });

  app.post('/api/instagram/alert/clear', async (req) => {
    clearAlert();
    auditWrite(actorOf(req), 'instagram.alert.clear', null, {});
    return { ok: true };
  });

  app.get('/api/instagram/device-log', async (req) => {
    const limit = Math.min(parseInt(req.query?.limit || '200', 10) || 200, 1000);
    const rows = store.listDeviceLog(limit);
    return rows.length ? rows : recentCommands(limit).map(c => ({ ...c, ok: c.ok ? 1 : 0 }));
  });

  // ── Group chat ──
  app.get('/api/instagram/chat', async (req) => {
    const limit = Math.min(parseInt(req.query?.limit || '60', 10) || 60, 300);
    const names = new Map(store.listMembers().map(m => [m.username, m.display_name || m.username]));
    return {
      enabled: isSkillEnabled('instagram-chat'),
      pollMinutes: config.instagram.chatPollMinutes,
      ...chatState(),
      messages: store.recentMessages(limit).map(m => ({
        id: m.id, fromMe: !!m.from_me, sender: m.sender, senderName: names.get(m.sender) || m.sender, kind: m.kind,
        text: m.text, reelAccount: m.reel_account, reelDescription: m.reel_description, replyToMe: !!m.reply_to_me,
        botAction: m.bot_action, seenAt: m.seen_at,
      })),
    };
  });

  // Check the group chat now (opens the thread even if it isn't unread).
  app.post('/api/instagram/chat/check', async (req, reply) => {
    try {
      auditWrite(actorOf(req), 'instagram.chat.check', null, {});
      return { ok: true, result: await checkChat({ trigger: 'manual', force: true }) };
    } catch (err) { fail(reply, err); }
  });

  app.get('/api/instagram/members', async () => store.listMembers().map(m => ({
    username: m.username, displayName: m.display_name, isSelf: !!m.is_self, admin: !!m.is_admin, inGroup: !!m.in_group,
    personJid: m.person_jid, personName: m.real_name || m.push_name || null, linkedBy: m.linked_by,
  })));

  // Link an Instagram member to a WhatsApp person (or unlink with personJid: null).
  app.post('/api/instagram/members/:username/link', async (req, reply) => {
    const personJid = req.body?.personJid ?? null;
    if (personJid !== null && (typeof personJid !== 'string' || !getPerson(personJid))) {
      reply.code(400).send({ error: 'unknown WhatsApp person' });
      return;
    }
    const changed = store.linkMember(req.params.username, personJid, actorOf(req));
    if (!changed) { reply.code(404).send({ error: 'unknown Instagram member' }); return; }
    auditWrite(actorOf(req), 'instagram.member.link', req.params.username, { personJid });
    return { ok: true };
  });

  app.get('/api/instagram/taste', async () => getTaste());

  app.put('/api/instagram/taste', async (req, reply) => {
    try {
      const card = writeTaste(req.body || {});
      auditWrite(actorOf(req), 'instagram.taste', null, { likes: card.likes.length, hardNo: card.hard_no.length });
      return card;
    } catch (err) { reply.code(400).send({ error: err.message }); }
  });

  // Live session events (reel-by-reel progress, queue changes, alerts) on the
  // multiplexed stream; a snapshot of the session state goes out on connect.
  registerTopic('instagram', {
    subscribe: (cb) => onDashboardEvent('instagram', cb),
    snapshot: () => ({ kind: 'snapshot', state: instagramState() }),
  });
}
