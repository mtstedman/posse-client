import { isAtlasSymbolId } from "../../../atlas/functions/v2/symbol-id.js";

// Research reports often identify a symbol by its language-level qualified
// name when the opaque ATLAS id is not close at hand. Keep those useful seeds,
// but reject prose, paths, and otherwise malformed values at this optional
// enrichment boundary.
const QUALIFIED_SYMBOL_RE = /^\\?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\\|::|[.#])[A-Za-z_$][A-Za-z0-9_$]*)+$/u;
const RESEARCH_SYMBOL_MAX_CHARS = 300;

export function isResearchSymbolSeed(value) {
  if (typeof value !== "string") return false;
  const seed = value.trim();
  return seed.length > 0
    && seed.length <= RESEARCH_SYMBOL_MAX_CHARS
    && (isAtlasSymbolId(seed) || QUALIFIED_SYMBOL_RE.test(seed));
}

export function normalizeResearchSymbolSeeds(values, maxItems = 12) {
  if (!Array.isArray(values)) return [];
  const limit = Math.max(0, Number.parseInt(String(maxItems), 10) || 0);
  const out = [];
  for (const value of values) {
    if (!isResearchSymbolSeed(value)) continue;
    const seed = value.trim();
    if (!out.includes(seed)) out.push(seed);
    if (out.length >= limit) break;
  }
  return out;
}

export function atlasSymbolRefFromResearchSeed(value) {
  if (!isResearchSymbolSeed(value) || isAtlasSymbolId(value.trim())) return null;
  const parts = value.trim().replace(/^\\/u, "").split(/\\|::|[.#]/u).filter(Boolean);
  const name = parts.at(-1) || "";
  return name ? { name } : null;
}
