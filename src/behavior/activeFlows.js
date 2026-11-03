import { logger } from '../utils/logger.js';

const activeFlows = new Map();
const FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function startFlow(groupJid, type, metadata = {}) {
  activeFlows.set(groupJid, { type, startedAt: Date.now(), metadata });
  logger.info({ groupJid, type }, 'Active flow started');
}

export function getActiveFlow(groupJid) {
  const flow = activeFlows.get(groupJid);
  if (!flow) return null;
  if (Date.now() - flow.startedAt > FLOW_TIMEOUT_MS) {
    activeFlows.delete(groupJid);
    logger.debug({ groupJid }, 'Active flow expired');
    return null;
  }
  return flow;
}

export function clearFlow(groupJid) {
  activeFlows.delete(groupJid);
  logger.info({ groupJid }, 'Active flow cleared');
}

export function refreshFlow(groupJid) {
  const flow = activeFlows.get(groupJid);
  if (flow) flow.startedAt = Date.now();
}
