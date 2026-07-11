// @ts-check

// Bump ATLAS_PARSER_SPEC_VERSION whenever persisted parser output changes
// shape or meaning. Warm jobs use this to decide whether a content-addressed
// blob can reuse its stored symbol/edge rows without running tree-sitter.
export const ATLAS_PARSER_VERSION = "atlas-v2-parser";
// edge-coverage-v1: JS require/re-export/dynamic-import edges, synthetic
// module anchors for import-only files, Rust #[derive] implements edges,
// Go multi-name const/var + receiver-method parenting, Python subscripted
// bases, JS signature body-boundary fix (encoder parse_extract changes).
// edge-coverage-v2: Python import edges persist the local binding in to_name
// and the original imported name in the module#original target.
export const ATLAS_PARSER_SPEC_VERSION = "edge-coverage-v2";
