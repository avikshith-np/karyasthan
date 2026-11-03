import { getIdentityText, writeIdentity } from '../../personality/systemPrompt.js';
import { auditWrite } from '../audit.js';
import { LEGACY_CAPABILITY_HEADINGS, findLegacyCapabilitySections } from '../../personality/capabilities.js';
import { actorOf } from '../auth.js';

export default async function identityRoutes(app) {
  app.get('/api/identity', async () => {
    const text = getIdentityText();
    // Spec 007 (O6): these sections duplicate the in-code capability manuals and
    // are stripped from the prompt at load; the Identity page warns about them.
    return {
      text,
      bytes: text.length,
      legacyHeadings: findLegacyCapabilitySections(text),
      legacyHeadingList: LEGACY_CAPABILITY_HEADINGS,
    };
  });

  app.put('/api/identity', async (req, reply) => {
    const body = req.body || {};
    const text = typeof body === 'string' ? body : body.text;
    if (typeof text !== 'string') {
      reply.code(400).send({ error: 'Body must be {text: "..."} or raw string' });
      return;
    }
    try {
      const result = writeIdentity(text);
      auditWrite(actorOf(req), 'identity.put', null, { bytes: text.length });
      return result;
    } catch (err) {
      reply.code(400).send({ error: err.message });
    }
  });
}
