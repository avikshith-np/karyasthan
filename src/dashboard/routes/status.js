import { config, getPersona } from '../../utils/config.js';
import { ROLE_NAMES, resolveRole } from '../../brain/roles.js';
import { getBudgets } from '../../brain/usage.js';
import { getDb } from '../../memory/db.js';
import { getWarmupSnapshot } from '../../behavior/warmup.js';
import { getAllCooldowns } from '../../behavior/rateLimiter.js';
import { lifeStatus } from './life.js';
import { geoStatus as lifeGeoStatus } from '../../life/index.js';
import { defaultConsentLanguage } from '../../brain/voiceClone.js';

// Per-role routing + month-to-date budget state for the topbar/status page.
// state: 'disabled' | 'shadow' (shadow-only role) | budget state 'ok' | 'over' | 'none'.
function rolesSummary() {
  let budgets = {};
  try { budgets = Object.fromEntries(getBudgets().map((b) => [b.name, b])); } catch { /* ledger unreadable */ }
  const roles = {};
  for (const name of ROLE_NAMES) {
    let eff;
    try { eff = resolveRole(name, config); } catch { continue; }
    const b = budgets[name];
    roles[name] = {
      provider: eff.provider || null,
      model: eff.model || null,
      fallback: eff.fallback?.provider ? { provider: eff.fallback.provider, model: eff.fallback.model || null } : null,
      state: eff.disabled ? 'disabled' : eff.shadowOnly ? 'shadow' : (b?.state || 'none'),
      budgetUsd: b?.budgetUsd ?? 0,
      spentUsd: b?.spentUsd ?? 0,
    };
  }
  const g = budgets.global;
  return { roles, budget: g ? { budgetUsd: g.budgetUsd, spentUsd: g.spentUsd, state: g.state } : null };
}

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
    const persona = getPersona();
    const { roles, budget } = rolesSummary();

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
      // Spec 007: the frontend names the bot and sets its clock from these —
      // nothing persona- or region-specific is hardcoded in public/.
      persona: { name: persona.name, displayName: persona.displayName || persona.name },
      // Default consent language for a voice enrollment (person page), from the persona's language.
      voiceConsentLanguage: defaultConsentLanguage(persona.language),
      timezone: config.timezone,
      roles,
      budget,
      // Spec 009: the topbar availability badge (all null while the engine is not running).
      life: lifeStatus(),
      // Spec 014: geo lookups (booleans only, never a URL or the contact email).
      geo: geoStatusSafe(),
    };
  });
}

// 014 geo: {enabled, nominatim, overpass, osrm} as booleans (configured), never a URL.
function geoStatusSafe() {
  try {
    const g = lifeGeoStatus();
    return { enabled: !!g?.enabled, nominatim: !!g?.hosts?.nominatim?.configured, overpass: !!g?.hosts?.overpass?.configured, osrm: !!g?.hosts?.osrm?.configured };
  } catch {
    return { enabled: false, nominatim: false, overpass: false, osrm: false };
  }
}
