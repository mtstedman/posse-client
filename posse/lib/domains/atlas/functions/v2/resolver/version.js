// @ts-check

// Resolver-only changes rebuild materialized views from cached parser rows.
// Keep this separate from the parser contract to avoid needless reparsing.
// v2: layer-merged external edges carry external_descriptor.
export const ATLAS_RESOLVER_VERSION = "atlas-v2-resolver-lexical-scope-v2";
