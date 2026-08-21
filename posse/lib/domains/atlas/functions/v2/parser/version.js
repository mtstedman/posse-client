// @ts-check

// `ATLAS_PARSER_VERSION` names the parser contract family that produced a
// persisted row. It participates in the currency test: a blob or layer written
// by a different producer (for example a SCIP indexer) is not a tree-sitter
// parse of the current contract.
export const ATLAS_PARSER_VERSION = "atlas-v2-parser";

// `ATLAS_PARSER_SPEC_VERSION` is the PRODUCING BUILD REVISION, recorded on
// blobs and layers for provenance and telemetry ("which build wrote this
// row"). It is deliberately NOT part of the currency test: a new ATLAS build
// that parses the same bytes into the same persisted shape must reuse stored
// work rather than re-warm the databases.
//
// Two things still force a re-parse, and both are explicit:
//   * `ATLAS_DATA_SCHEMA_VERSION` (contracts/ddl/index.js) — the encoding
//     axis. Bumping it changes the shape, columns, or meaning of persisted
//     rows and cold-boots every rebuildable store. A change like
//     `edge-coverage-v2` below (Python import edges changed what `to_name`
//     MEANS) belongs on that axis.
//   * `Ledger.requestParserReparse()` (`posse atlas-v2 reparse`) — the
//     operator maintenance action. It records the current spec version as the
//     ledger's re-parse floor, so blobs produced by an earlier revision stop
//     being current without discarding any stored rows.
//
// Bumping the string below on its own is a provenance stamp, nothing more.
//
// edge-coverage-v1: JS require/re-export/dynamic-import edges, synthetic
// module anchors for import-only files, Rust #[derive] implements edges,
// Go multi-name const/var + receiver-method parenting, Python subscripted
// bases, JS signature body-boundary fix (encoder parse_extract changes).
// edge-coverage-v2: Python import edges persist the local binding in to_name
// and the original imported name in the module#original target.
// edge-coverage-v3/v4: native parser coverage revisions.
// edge-coverage-v5: TypeScript ambient signatures and BOM-aware UTF-16 source
// decoding.
export const ATLAS_PARSER_SPEC_VERSION = "edge-coverage-v5";
