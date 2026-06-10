// @ts-check
//
// SCIP precision → ATLAS row confidence (integer 0..100). SCIP refs are
// compiler-bound, so there is no per-ref ambiguity penalty: a definition
// occurrence is essentially asserted (98), and references share the
// scip-resolved tier because the compiler supplied the binding. The heuristic
// ladder caps below this in `lib/domains/atlas/functions/v2/resolver/confidence.js`, so
// any SCIP edge sorts above heuristic-bound edges by construction.

export const SCIP_CONFIDENCE_DEFINITION = 98;
export const SCIP_CONFIDENCE_REFERENCE = 98;

/**
 * @param {boolean} isDefinition
 * @returns {number}
 */
export function scipConfidence(isDefinition) {
  return isDefinition ? SCIP_CONFIDENCE_DEFINITION : SCIP_CONFIDENCE_REFERENCE;
}
