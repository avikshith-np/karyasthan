/**
 * Helpers for rendering message rows into the `[Speaker]: text` transcript lines
 * fed to the LLM. The model infers turn ownership purely from these lines, so each
 * rendered message MUST stay on a single physical line — otherwise a message
 * containing a newline spills into label-less continuation lines that the model
 * folds onto the next speaker (cross-attribution: "B said what A said").
 */

/**
 * Collapse intra-message newlines (and surrounding whitespace) into a single-line
 * separator so one message renders as exactly one transcript line. Falls back to a
 * `[type]` placeholder when there is no text content (e.g. media without a caption).
 */
export function flattenContent(content, messageType) {
  const raw = content || `[${messageType}]`;
  return String(raw).replace(/\s*\n\s*/g, ' / ').trim();
}
