// @ts-check
//
// Confidence scoring for the edge resolver. Mirrors atlas-mcp's
// `edge-confidence.js` so cross-tool comparisons stay sensible: compiler
// SCIP bindings score ~0.98; in-repo name-resolved bindings score ~0.92;
// direct import bindings score ~0.85; a `heuristic` global name-match scores
// ~0.72 minus an ambiguity penalty when multiple candidates fit.
//
// All values are 0..1 floats. Edges store an integer percentage
// (0..100, clamped) in the EdgeRow.confidence field — the conversion
// happens at the call site so this module stays pure.

/** @typedef {"scip-resolved" | "name-resolved" | "import-direct" | "exact" | "heuristic" | "unresolved"} ResolutionStrategy */

/**
 * @param {number} value
 * @returns {number}
 */
function clampConfidence(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Baseline confidence for a resolution strategy, before any
 * ambiguity-based adjustments.
 *
 * @param {ResolutionStrategy} strategy
 * @returns {number}
 */
export function defaultConfidenceForStrategy(strategy) {
  switch (strategy) {
    case "scip-resolved": return 0.98;
    case "name-resolved": return 0.92;
    case "exact":         return 0.92;
    case "import-direct": return 0.85;
    case "heuristic":     return 0.72;
    case "unresolved":    return 0.2;
    default:              return 0.5;
  }
}

/**
 * @typedef {Object} CalibrateInput
 * @property {boolean} isResolved
 * @property {ResolutionStrategy} [strategy]
 * @property {number} [baseConfidence]
 * @property {number} [candidateCount]   Number of candidates the strategy considered.
 *   Multiple candidates → ambiguity penalty.
 */

/**
 * Compute the final 0..1 confidence for a resolution.
 *
 * @param {CalibrateInput} input
 * @returns {{ confidence: number, strategy: ResolutionStrategy }}
 */
export function calibrateResolutionConfidence(input) {
  const strategy = input.strategy ?? (input.isResolved ? "heuristic" : "unresolved");
  const baseline = typeof input.baseConfidence === "number"
    ? input.baseConfidence
    : defaultConfidenceForStrategy(strategy);
  const ambiguityPenalty = input.candidateCount && input.candidateCount > 1
    ? Math.min(0.35, input.candidateCount * 0.04)
    : 0;
  const confidence = clampConfidence(baseline - ambiguityPenalty);
  return { confidence, strategy };
}

/**
 * Convert a 0..1 float confidence into the 0..100 integer the
 * EdgeRow.confidence column expects.
 *
 * @param {number} confidence
 * @returns {number}
 */
export function toEdgeConfidence(confidence) {
  const clamped = clampConfidence(confidence);
  return Math.round(clamped * 100);
}
