// @ts-check

// Bump ATLAS_PARSER_SPEC_VERSION whenever persisted parser output changes
// shape or meaning. Warm jobs use this to decide whether a content-addressed
// blob can reuse its stored symbol/edge rows without running tree-sitter.
export const ATLAS_PARSER_VERSION = "atlas-v2-parser";
export const ATLAS_PARSER_SPEC_VERSION = "body-identifiers-v1";
