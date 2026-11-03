// Public site (spec 013): the dashboard's Public page API. Everything goes through the
// exporter facade (src/public/index.js). Writes: DASHBOARD_READONLY=false + CSRF (global
// guards), 10/min (export 2/min), no loopback exemption, audited `public.*` with ids only
// (a person's display name is the owner's own text and is not echoed into the audit).
import { config } from '../../utils/config.js';
import { auditWrite } from '../audit.js';
import { getDb } from '../../memory/db.js';
import * as publicSite from '../../public/index.js';
import { actorOf } from '../auth.js';

const limit = (max, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow, allowList: [] } });
const WRITE = limit(10);
const EXPORT = limit(2);
const JID_RE = /^[0-9A-Za-z._:+-]{3,64}@(?:s\.whatsapp\.net|lid)$/;

export default async function publicSiteRoutes(app) {
  app.get('/api/public/status', async () => publicSite.status());

  // The exact document the site would get (operator view; it is public data by construction).
  app.get('/api/public/preview', async () => ({ doc: await publicSite.preview() }));

  app.post('/api/public/export', { config: EXPORT }, async (req) => {
    const res = await publicSite.exportNow({ upload: true });
    auditWrite(actorOf(req), 'public.export', 'now', { status: res.status, uploaded: res.uploaded === true, size: res.size ?? null });
    return res;
  });

  app.post('/api/public/takedown', { config: WRITE }, async (req, reply) => {
    if (req.body?.confirm !== true) return reply.code(400).send({ error: 'confirm:true is required' });
    const res = await publicSite.takedown();
    auditWrite(actorOf(req), 'public.takedown', 'site', { ok: res.ok, uploaded: res.uploaded === true, reason: res.reason ?? null });
    return res;
  });

  // Opt-in rows joined with the person's names (operator view).
  app.get('/api/public/people', async () => {
    const db = getDb();
    const rows = publicSite.people();
    return {
      people: rows.map((r) => {
        let p = null;
        try { p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(r.personJid); } catch { p = null; }
        return { ...r, realName: p?.real_name ?? null, pushName: p?.push_name ?? null };
      }),
    };
  });

  app.get('/api/public/people/:jid', async (req, reply) => {
    const jid = String(req.params.jid || '');
    if (!JID_RE.test(jid)) return reply.code(400).send({ error: 'bad jid' });
    return { setting: publicSite.personSetting(jid) };
  });

  app.put('/api/public/people/:jid', { config: WRITE }, async (req, reply) => {
    const jid = String(req.params.jid || '');
    if (!JID_RE.test(jid)) return reply.code(400).send({ error: 'bad jid' });
    const b = req.body || {};
    if (b.optedIn !== undefined && typeof b.optedIn !== 'boolean') return reply.code(400).send({ error: 'optedIn must be boolean' });
    if (b.displayName !== undefined && (typeof b.displayName !== 'string' || b.displayName.length > 40)) return reply.code(400).send({ error: 'displayName ≤ 40 chars' });
    let row;
    try {
      row = publicSite.setOptIn(jid, { optedIn: b.optedIn, displayName: b.displayName }, actorOf(req));
    } catch (err) {
      const code = err?.code === 'unknown_person' ? 404 : 400;
      return reply.code(code).send({ error: err?.code || 'failed' });
    }
    auditWrite(actorOf(req), 'public.person', row.personJid, { optedIn: row.optedIn, publicId: row.publicId });
    return { setting: row };
  });
}
