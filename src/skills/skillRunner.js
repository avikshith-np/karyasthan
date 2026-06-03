import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each entry: { skill, enabled }. Dashboard can flip `enabled` at runtime.
const registry = [];

/**
 * Auto-discover and load all *.skill.js modules in this directory.
 */
export async function loadSkills() {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.skill.js'));

  for (const file of files) {
    try {
      const mod = await import(`./${file}`);
      const skill = mod.default;
      if (skill?.name && skill?.shouldHandle && skill?.handle) {
        registry.push({ skill, enabled: true });
        logger.info({ skill: skill.name }, 'Skill loaded');
      } else {
        logger.warn({ file }, 'Skill file missing required exports (name, shouldHandle, handle)');
      }
    } catch (err) {
      logger.error({ err: err.message, file }, 'Failed to load skill');
    }
  }

  logger.info({ count: registry.length }, 'Skills loaded');
  return registry.map(e => e.skill);
}

export function listSkills() {
  return registry.map(({ skill, enabled }) => ({
    name: skill.name,
    description: skill.description || null,
    enabled,
  }));
}

export function setSkillEnabled(name, enabled) {
  const entry = registry.find(e => e.skill.name === name);
  if (!entry) return false;
  entry.enabled = !!enabled;
  if (!enabled && typeof entry.skill.onDisable === 'function') {
    try { entry.skill.onDisable(); } catch (err) {
      logger.warn({ err: err.message, skill: name }, 'skill.onDisable threw');
    }
  }
  logger.info({ skill: name, enabled: !!enabled }, 'Skill toggled');
  return true;
}

/**
 * Run loaded skills against a message. First matching enabled skill handles it.
 * Returns { handled: true } if a skill handled the message, { handled: false } otherwise.
 */
export async function runSkills(sock, msg, context) {
  for (const { skill, enabled } of registry) {
    if (!enabled) continue;
    try {
      if (skill.shouldHandle(msg, context)) {
        logger.info({ skill: skill.name, msgId: msg.id }, 'Skill matched');
        const handled = await skill.handle(sock, msg, context);
        if (handled !== false) {
          return { handled: true };
        }
      }
    } catch (err) {
      logger.error({ err: err.message, skill: skill.name, msgId: msg.id }, 'Skill error');
    }
  }
  return { handled: false };
}
