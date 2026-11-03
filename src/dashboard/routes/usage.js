import { config } from '../../utils/config.js';
import { getUsageByDay, getUnpricedModels, getBudgets } from '../../brain/usage.js';
import { getAgreement } from '../../brain/prefilter.js';
import { isSkillEnabled, listSkills } from '../../skills/skillRunner.js';
import { onDashboardEvent } from '../events.js';
import { registerTopic } from '../sse.js';

// Read-only usage ledger for the Usage page (spec 007 US2). All SQL lives in
// usage.js / prefilter.js and is parameterised there; this module only clamps
// the query inputs.

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// The jev-prefilter manifest skill is the on/off switch; before skills load (or
// when it isn't installed) fall back to its boot default.
function prefilterEnabled() {
  try {
    const loaded = listSkills() || [];
    if (loaded.some((s) => s.name === 'jev-prefilter')) return isSkillEnabled('jev-prefilter');
  } catch { /* skills not loaded */ }
  return !!config.prefilter?.enabled;
}

export default async function usageRoutes(app) {
  // Throttled (1/s) trigger from usage.js after ledger writes — the page refetches.
  registerTopic('usage', {
    subscribe: (cb) => onDashboardEvent('usage', cb),
  });

  app.get('/api/usage', async (req) => {
    const days = clampInt(req.query?.days, 1, 180, 30);
    return { days: getUsageByDay(days), unpriced: getUnpricedModels(days), window: days };
  });

  app.get('/api/usage/budgets', async () => getBudgets());

  app.get('/api/usage/prefilter', async (req) => {
    const limit = clampInt(req.query?.limit, 1, 10_000, config.prefilter?.shadowTarget || 300);
    let agreement;
    try {
      agreement = getAgreement({ limit });
    } catch {
      // prefilter_log missing (migration not run) — an empty read, not a 500.
      agreement = { n: 0, target: config.prefilter?.shadowTarget || 300, skipBelow: config.prefilter?.skipBelow,
        llmSkips: 0, caughtSkips: 0, replies: 0, falseSkips: 0, catchRate: null, falseSkipRate: null,
        recommendEnforce: false, unavailable: true };
    }
    return { ...agreement, enabled: prefilterEnabled(), mode: config.prefilter?.mode || 'shadow', limit };
  });
}
