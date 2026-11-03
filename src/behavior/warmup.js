import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { safePath } from '../utils/pathGuard.js';
import { logger } from '../utils/logger.js';

const WARMUP_FILE = safePath('./data/warmup.json');

/*
  Warm-up schedule (days counted in config.timezone):
  Days 1-3:   max 5 msgs/day,  reactions only (no text)
  Days 4-7:   max 15 msgs/day, text allowed
  Days 8-14:  max 30 msgs/day
  Days 15-21: max 50 msgs/day
  Days 22+:   unlimited
*/
const WARMUP_TIERS = [
  { maxDay: 3,  maxMsgsDay: 5,  textAllowed: false },
  { maxDay: 7,  maxMsgsDay: 15, textAllowed: true },
  { maxDay: 14, maxMsgsDay: 30, textAllowed: true },
  { maxDay: 21, maxMsgsDay: 50, textAllowed: true },
];

/** Today's date key (YYYY-MM-DD) in the configured timezone, not UTC. */
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}

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
      startDate: todayKey(),
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
  // Diff two calendar-date keys (both read as UTC midnight) so the day rolls over
  // at local midnight, in step with the dailyCounts keys.
  const start = Date.parse(`${state.startDate}T00:00:00Z`);
  const today = Date.parse(`${todayKey()}T00:00:00Z`);
  return Math.floor((today - start) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Get the current warmup tier, or null if warm-up is complete.
 */
export function getCurrentTier() {
  if (!config.warmupEnabled) return null;

  const day = getWarmupDay();
  for (const [i, tier] of WARMUP_TIERS.entries()) {
    if (day <= tier.maxDay) return { ...tier, day, tierIndex: i + 1, tierCount: WARMUP_TIERS.length };
  }
  return null; // warm-up complete
}

/**
 * Check if an action is allowed under warm-up constraints.
 * Returns { allowed, reason, responseType } — responseType is the type the caller
 * may actually send: on a reactions-only tier 'text_and_reaction' is downgraded to
 * 'reaction' (downgraded: true), so callers must act on it, not the decision's type.
 */
export function checkWarmup(responseType) {
  const tier = getCurrentTier();

  // Warm-up complete
  if (!tier) return { allowed: true, reason: null, responseType };

  // Check daily message count
  const state = loadState();
  const todayCount = state.dailyCounts[todayKey()] || 0;

  if (todayCount >= tier.maxMsgsDay) {
    return { allowed: false, reason: `Warmup day ${tier.day}: daily limit ${tier.maxMsgsDay} reached`, responseType };
  }

  // Check if text is allowed
  if (!tier.textAllowed) {
    if (responseType === 'text') {
      return { allowed: false, reason: `Warmup day ${tier.day}: text not allowed yet (reactions only)`, responseType };
    }
    if (responseType === 'text_and_reaction') {
      return { allowed: true, reason: `Warmup day ${tier.day}: text not allowed yet, reacting only`, responseType: 'reaction', downgraded: true };
    }
  }

  return { allowed: true, reason: null, responseType };
}

/**
 * Read-only snapshot of warmup state for dashboard/status endpoints.
 */
export function getWarmupSnapshot() {
  const state = loadState();
  const today = todayKey();
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
  const today = todayKey();
  state.dailyCounts[today] = (state.dailyCounts[today] || 0) + 1;

  // Clean old entries (keep last 7 days)
  const keys = Object.keys(state.dailyCounts).sort();
  while (keys.length > 7) {
    delete state.dailyCounts[keys.shift()];
  }

  saveState();
}
