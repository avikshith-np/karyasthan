import path from 'path';
import { config } from './config.js';

/**
 * Resolves a path and ensures it's within the project root.
 * Throws if the path escapes the sandbox.
 */
export function safePath(p) {
  const resolved = path.resolve(config.projectRoot, p);
  if (!resolved.startsWith(config.projectRoot)) {
    throw new Error(`Access denied — path escapes project root: ${p}`);
  }
  return resolved;
}
