import { auditWrite } from '../audit.js';
import { onDashboardEvent } from '../events.js';
import { registerTopic } from '../sse.js';
import { getCall, getTranscript, listCalls } from '../../memory/callStore.js';
import {
  startOutboundCall, hangupActiveCall, callsStatus, dialableNumber, CallError,
} from '../../calls/callManager.js';
import { callAudience } from '../../calls/callPrompt.js';
import { canUseChatContent } from '../../memory/recall.js';
import { actorOf } from '../auth.js';

function publicRow(r) {
  return {
    id: r.id, direction: r.direction, context: r.context,
    personJid: r.person_jid, groupJid: r.group_jid, phone: r.phone,
    status: r.status, endReason: r.end_reason,
    startedAt: r.started_at, answeredAt: r.answered_at, endedAt: r.ended_at,
    durationSec: r.answered_at && r.ended_at ? r.ended_at - r.answered_at : null,
    summary: r.summary,
  };
}

export default async function callsRoutes(app) {
  // History for a person (1:1 + inbound) or a group (group-context calls).
  app.get('/api/calls', async (req) => {
    const personJid = req.query?.person ? String(req.query.person) : undefined;
    const groupJid = req.query?.group ? String(req.query.group) : undefined;
    const limit = Math.min(parseInt(req.query?.limit || '20', 10) || 20, 100);
    return listCalls({ personJid, groupJid, limit }).map(publicRow);
  });

  app.get('/api/calls/:id', async (req, reply) => {
    const row = getCall(Number(req.params.id));
    if (!row) { reply.code(404).send({ error: 'call not found' }); return; }
    return { ...publicRow(row), transcript: getTranscript(row.id) };
  });

  // Whether the call button can work for this person (number known + allowed).
  app.get('/api/calls/dialable/:jid', async (req) => {
    try {
      return { dialable: !!(await dialableNumber(req.params.jid)) };
    } catch (err) {
      return { dialable: false, reason: err.message };
    }
  });

  // Place a call. The number is resolved server-side from the person's JID; the
  // request never carries a raw number. groupJid present → group context, allowed
  // only while the callee is a fresh current member of that group (spec 006 R2):
  // 409 otherwise, and the UI retries with DM context. startOutboundCall re-checks.
  app.post('/api/calls', async (req, reply) => {
    const body = req.body || {};
    if (typeof body.personJid !== 'string' || !body.personJid) {
      reply.code(400).send({ error: 'personJid required' });
      return;
    }
    const groupJid = typeof body.groupJid === 'string' && body.groupJid ? body.groupJid : null;
    if (groupJid && !canUseChatContent(callAudience(body.personJid), groupJid)) {
      reply.code(409).send({ error: 'not a current member of that group (or membership not synced yet) — use DM context', code: 'group_context_not_allowed' });
      return;
    }
    const actor = actorOf(req);
    try {
      const call = await startOutboundCall({ personJid: body.personJid, groupJid, actor });
      auditWrite(actor, 'call.start', body.personJid, { callId: call.id, groupJid, context: call.context });
      return call;
    } catch (err) {
      reply.code(err instanceof CallError ? err.status : 500).send({ error: err.message });
    }
  });

  app.post('/api/calls/hangup', async (req) => {
    const actor = actorOf(req);
    const ok = hangupActiveCall();
    if (ok) auditWrite(actor, 'call.hangup', null, {});
    return { ok };
  });

  // Live call events (state changes, transcript partials and lines, end, summary)
  // on the multiplexed stream; a snapshot of the live state goes out on connect.
  registerTopic('calls', {
    subscribe: (cb) => onDashboardEvent('call', cb),
    snapshot: () => ({ kind: 'snapshot', ...callsStatus() }),
  });
}
