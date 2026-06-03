import { getIdentityText, writeIdentity } from '../../personality/systemPrompt.js';
import { config } from '../../utils/config.js';
import { auditWrite } from '../audit.js';

export default async function identityRoutes(app) {
  app.get('/api/identity', async () => {
    const text = getIdentityText();
    return { text, bytes: text.length };
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
      auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'identity.put', null, { bytes: text.length });
      return result;
    } catch (err) {
      reply.code(400).send({ error: err.message });
    }
  });
}
