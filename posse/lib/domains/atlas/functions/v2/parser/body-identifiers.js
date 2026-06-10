// @ts-check

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MAX_BODY_TEXT_CHARS = 80_000;
const DEFAULT_MAX_TOKENS = 600;

/**
 * Build a compact lexical body index for one symbol range. This is not
 * source text; it is a deduped identifier-token bag suitable for FTS.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @param {{ maxTokens?: number }} [opts]
 * @returns {string}
 */
export function extractBodyIdentifiers(source, start, end, opts = {}) {
  const maxTokens = Number.isInteger(opts.maxTokens) && opts.maxTokens > 0
    ? /** @type {number} */ (opts.maxTokens)
    : DEFAULT_MAX_TOKENS;
  const safeStart = Math.max(0, Math.min(Number(start) || 0, source.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, source.length));
  const slice = source.slice(safeStart, Math.min(safeEnd, safeStart + MAX_BODY_TEXT_CHARS));
  const tokens = new Set();
  for (const match of slice.matchAll(IDENTIFIER_RE)) {
    addIdentifierTokens(tokens, match[0], maxTokens);
    if (tokens.size >= maxTokens) break;
  }
  return [...tokens].join(" ");
}

/**
 * @param {Set<string>} out
 * @param {string} identifier
 * @param {number} maxTokens
 */
function addIdentifierTokens(out, identifier, maxTokens) {
  const raw = String(identifier || "").trim();
  if (!raw) return;
  pushToken(out, raw, maxTokens);
  const broken = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const piece of broken.split(/[^A-Za-z0-9_$]+|_/)) {
    pushToken(out, piece, maxTokens);
    if (out.size >= maxTokens) return;
  }
}

/**
 * @param {Set<string>} out
 * @param {string} token
 * @param {number} maxTokens
 */
function pushToken(out, token, maxTokens) {
  if (out.size >= maxTokens) return;
  const text = String(token || "").trim();
  if (text.length < 2) return;
  out.add(text);
}
