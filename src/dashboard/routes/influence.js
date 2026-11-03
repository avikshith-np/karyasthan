// Chats shape his life (spec 012 plan "P1 dashboard"): the read-only API behind
// Life · Now's "CHATS ON HIS DAY" panel. A route file of its own so routes/life.js
// stays as it is.
//
// Everything goes through the life facade (src/life/index.js). The dashboard is
// the operator view (every origin), but never message text: chat names, codes,
// ids, counts and the overlay's numbers only — except the advice tray (P3),
// which shows the owner the advice itself, read live (gone once the message is
// forgotten, revoked, edited or expired), like the claim tray shows claims. Reverting a blip, a sleep push or a
// work flag is the existing POST /api/life/events/:id/revert (these types are
// revertible). With the engine not running the read answers 200 with an "off"
// shape — never a 500.
import { getDb } from '../../memory/db.js';
import * as life from '../../life/index.js';
import { auditWrite } from '../audit.js';
import { toId } from './life.js';
import { WRITE, actorOf, writeGate, limitOf } from './arcs.js';

// The advice tray's statuses (the facade re-validates).
export const ADVICE_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'withdrawn']);
const ADVICE_MAX = 100;

function chatName(db, jid) {
  if (typeof jid !== 'string' || !jid) return null;
  try {
    if (jid.endsWith('@g.us')) return db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name || null;
    const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(jid);
    return p?.real_name || p?.push_name || null;
  } catch {
    return null;
  }
}

const OFF = Object.freeze({
  running: false, skill: false, lifeOn: false, degraded: false, on: {}, areas: {}, caps: null, overlay: null,
  blips: [], sleep: null, workBehindToday: false, counts: [], perceptions: null,
});

export default async function influenceRoutes(app) {
  app.get('/api/influence/now', async () => {
    let v = null;
    try { v = life.isLifeOn() || life.getState() ? life.influenceNow() : null; } catch { v = null; }
    if (!v) return { ...OFF };
    const db = getDb();
    const names = new Map();
    const nameOf = (jid) => { if (!names.has(jid)) names.set(jid, chatName(db, jid)); return names.get(jid); };
    return {
      running: true,
      ...v,
      blips: (v.blips || []).map(b => ({ ...b, chatName: nameOf(b.chatJid) })),
      sleep: v.sleep ? { ...v.sleep, chatName: nameOf(v.sleep.chatJid) } : null,
    };
  });

  // P2: invitations from chats (Life · Pending): the decision, its state, his
  // answer and the follow-up — chat names and code-built labels, never the message.
  app.get('/api/influence/invites', async () => {
    let list = null;
    try { list = life.isLifeOn() || life.getState() ? life.influenceInvites(30) : null; } catch { list = null; }
    if (!list) return { running: false, invites: [] };
    const db = getDb();
    const names = new Map();
    const nameOf = (jid) => { if (!names.has(jid)) names.set(jid, chatName(db, jid)); return names.get(jid); };
    return { running: true, invites: list.map(i => ({ ...i, chatName: nameOf(i.chatJid) })) };
  });

  // P3: advice from chats on the owner's tray (Story · From chats, Director ·
  // Suggestions from chats): the code-built summary and the live excerpt.
  app.get('/api/influence/advice', async (req, reply) => {
    const raw = req.query?.status;
    const status = raw === undefined || raw === '' || raw === 'all' ? null : String(raw);
    if (status !== null && !ADVICE_STATUSES.has(status)) return reply.code(400).send({ error: 'bad status' });
    const db = getDb();
    const names = new Map();
    const nameOf = (jid) => { if (!jid) return null; if (!names.has(jid)) names.set(jid, chatName(db, jid)); return names.get(jid); };
    let list = [];
    try { list = life.influenceAdvice({ status, limit: limitOf(req.query?.limit, 50, ADVICE_MAX), nameOf }); } catch { list = []; }
    return { advice: Array.isArray(list) ? list : [] };
  });

  // Approve → the row is approved and the answer carries a Director preset (its
  // category); nothing is written to his world. Reject → rejected. Owner writes:
  // readonly + CSRF (global guards), 10/min with no loopback exemption, 409 while
  // life or arcs is off, audited with ids and the category only.
  for (const verdict of ['approve', 'reject']) {
    app.post('/api/influence/advice/:id/' + verdict, { config: WRITE }, async (req, reply) => {
      const id = toId(req.params.id);
      if (!id) return reply.code(400).send({ error: 'bad advice id' });
      if (!(await writeGate(reply))) return reply;
      let out;
      try { out = life.influenceAdviceDecide(id, verdict, { by: actorOf(req) }); } catch { out = { ok: false, reason: 'failed' }; }
      if (!out?.ok) {
        const code = out?.reason === 'not_found' ? 404 : 409;
        return reply.code(code).send({ error: ['off', 'not_found', 'not_pending'].includes(out?.reason) ? out.reason : 'failed' });
      }
      auditWrite(actorOf(req), `chatInfluence.advice.${verdict}`, String(id), { id, category: out.category ?? null });
      return out;
    });
  }

  // The Day page's influence lane (?from=&to= unix seconds, ≤ 48 h; default the last 24 h).
  app.get('/api/influence/lane', async (req) => {
    const now = Math.floor(Date.now() / 1000);
    const to = /^\d{1,12}$/.test(String(req.query?.to ?? '')) ? Number(req.query.to) : now;
    const from0 = /^\d{1,12}$/.test(String(req.query?.from ?? '')) ? Number(req.query.from) : to - 86400;
    const from = Math.max(from0, to - 2 * 86400);
    let lane = [];
    try { lane = life.influenceLane({ from, to }); } catch { lane = []; }
    const db = getDb();
    const names = new Map();
    const nameOf = (jid) => { if (!jid) return null; if (!names.has(jid)) names.set(jid, chatName(db, jid)); return names.get(jid); };
    return { from, to, lane: lane.map(e => ({ ...e, chatName: nameOf(e.chatJid) })) };
  });
}
