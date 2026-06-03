import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { safePath } from '../utils/pathGuard.js';
import { logger } from '../utils/logger.js';

const WARMUP_FILE = safePath('./data/warmup.json');

/*
  Warm-up schedule:
  Days 1-3:  max 1 group,  max 5 msgs/day,  reactions only (no text)
  Days 4-7:  max 2 groups, max 15 msgs/day,  short text allowed
  Days 8-14: max 3 groups, max 30 msgs/day,  50% normal rate
  Days 15-21: max 5 groups, max 50 msgs/day, 75% normal rate
  Days 22+:  unlimited
*/
const WARMUP_TIERS = [
  { maxDay: 3,  maxGroups: 1,  maxMsgsDay: 5,  rateMultiplier: 0, textAllowed: false },
  { maxDay: 7,  maxGroups: 2,  maxMsgsDay: 15, rateMultiplier: 0.5, textAllowed: true },
  { maxDay: 14, maxGroups: 3,  maxMsgsDay: 30, rateMultiplier: 0.5, textAllowed: true },
  { maxDay: 21, maxGroups: 5,  maxMsgsDay: 50, rateMultiplier: 0.75, textAllowed: true },
];

let warmupState = null;

function loadState() {
  if (warmupState) return warmupState;

  try {
    if (fs.existsSync(WARMUP_FILE)) {
      warmupState = JSON.parse(fs.readFileSync(WARMUP_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }

  if (!warmupState) {
    warmupState = {
      startDate: new Date().toISOString().split('T')[0],
      dailyCounts: {},
    };
    saveState();
  }

  return warmupState;
}

function saveState() {
  try {
    const dir = path.dirname(WARMUP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WARMUP_FILE, JSON.stringify(warmupState, null, 2));
  } catch (err) {
    logger.debug({ err }, 'Failed to save warmup state');
  }
}

/**
 * Get the current warmup day (1-indexed)
 */
export function getWarmupDay() {
  const state = loadState();
  const start = new Date(state.startDate);
  const now = new Date();
  const diffMs = now - start;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Get the current warmup tier, or null if warm-up is complete.
 */
export function getCurrentTier() {
  if (!config.warmupEnabled) return null;

  const day = getWarmupDay();
  for (const tier of WARMUP_TIERS) {
    if (day <= tier.maxDay) return { ...tier, day };
  }
  return null; // warm-up complete
}

/**
 * Check if an action is allowed under warm-up constraints.
 * Returns { allowed, reason, rateMultiplier }
 */
export function checkWarmup(responseType) {
  const tier = getCurrentTier();

  // Warm-up complete
  if (!tier) return { allowed: true, reason: null, rateMultiplier: 1.0 };

  // Check daily message count
  const today = new Date().toISOString().split('T')[0];
  const state = loadState();
  const todayCount = state.dailyCounts[today] || 0;

  if (todayCount >= tier.maxMsgsDay) {
    return { allowed: false, reason: `Warmup day ${tier.day}: daily limit ${tier.maxMsgsDay} reached`, rateMultiplier: 0 };
  }

  // Check if text is allowed
  if (!tier.textAllowed && responseType === 'text') {
    return { allowed: false, reason: `Warmup day ${tier.day}: text not allowed yet (reactions only)`, rateMultiplier: 0 };
  }

  return { allowed: true, reason: null, rateMultiplier: tier.rateMultiplier };
}

/**
 * Read-only snapshot of warmup state for dashboard/status endpoints.
 */
export function getWarmupSnapshot() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  return {
    enabled: !!config.warmupEnabled,
    startDate: state.startDate,
    day: getWarmupDay(),
    tier: getCurrentTier(),
    todayCount: state.dailyCounts[today] || 0,
    dailyCounts: { ...state.dailyCounts },
  };
}

/**
 * Record a sent message for warm-up tracking.
 */
export function recordSent() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  state.dailyCounts[today] = (state.dailyCounts[today] || 0) + 1;

  // Clean old entries (keep last 7 days)
  const keys = Object.keys(state.dailyCounts).sort();
  while (keys.length > 7) {
    delete state.dailyCounts[keys.shift()];
  }

  saveState();
}
