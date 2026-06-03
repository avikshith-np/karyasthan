import { listSkills, setSkillEnabled } from '../../skills/skillRunner.js';
import { config } from '../../utils/config.js';
import { auditWrite } from '../audit.js';

export default async function skillsRoutes(app) {
  app.get('/api/skills', async () => listSkills());

  app.post('/api/skills/:name/toggle', async (req, reply) => {
    const name = req.params.name;
    const enabled = !!req.body?.enabled;
    const ok = setSkillEnabled(name, enabled);
    if (!ok) { reply.code(404).send({ error: 'skill not found' }); return; }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'skill.toggle', name, { enabled });
    return { ok: true, name, enabled };
  });
}
