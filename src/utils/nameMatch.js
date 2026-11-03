// Pure: imported by mentions.js, and by tests that must not load an install's settings.

/**
 * Is this name in the text? It starts at a word boundary. A name of up to 3 letters must also end
 * at one, so "sam" isn't in "same". A longer one may carry a suffix ("karyasthaa", "samine").
 */
const nameRegexes = new Map();
export function textHasName(content, name) {
  if (!content || !name) return false;
  const n = String(name).toLowerCase();
  let re = nameRegexes.get(n);
  if (!re) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}${[...n].length <= 3 ? '(?![\\p{L}\\p{N}\\p{M}])' : ''}`, 'u');
    nameRegexes.set(n, re);
  }
  return re.test(String(content).toLowerCase());
}
