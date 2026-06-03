import { config } from '../../utils/config.js';
import { getDb } from '../../memory/db.js';
import { getWarmupSnapshot } from '../../behavior/warmup.js';
import { getAllCooldowns } from '../../behavior/rateLimiter.js';

export default async function statusRoutes(app, opts) {
  const { getSock } = opts;

  app.get('/api/health', async () => {
    let dbOpen = false;
    try { getDb().prepare('SELECT 1').get(); dbOpen = true; } catch {}
    const sock = getSock?.();
    return {
      ok: true,
      dbOpen,
      sockState: sock?.user ? 'open' : 'close',
    };
  });

  app.get('/api/status', async () => {
    const sock = getSock?.();
    const connected = !!sock?.user;
    const uptimeSec = Math.floor(process.uptime());
    const mem = process.memoryUsage();

    return {
      connected,
      sockUser: sock?.user ? { id: sock.user.id, name: sock.user.name } : null,
      uptimeSec,
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      },
      warmup: getWarmupSnapshot(),
      dryRun: config.dryRun,
      sleepWindow: {
        startHour: config.sleepStartHour,
        endHour: config.sleepEndHour,
        timezone: config.timezone,
      },
      rateCaps: {
        perGroupHour: config.maxPerGroupHour,
        globalHour: config.maxGlobalHour,
      },
      cooldowns: getAllCooldowns(),
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
      },
      toggles: {
        warmup: config.warmupEnabled,
        imageGen: config.imageGen.enabled,
        voiceNote: config.voiceNote.enabled,
        qualityGate: config.qualityGate.enabled,
      },
      readOnly: config.dashboard.readOnly,
    };
  });
}
