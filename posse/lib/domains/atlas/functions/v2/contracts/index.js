// @ts-check
//
// ATLAS v2 contracts barrel.
//
// ============================================================================
// CONVENTIONS (Phase 1 entry criteria — every workstream owner must follow)
// ============================================================================
//
// 1. Every v2 implementation file MUST start with `// @ts-check`. The
//    project tsconfig has `checkJs: false`, so JSDoc only bites on files
//    that opt in. Without the directive, contracts produce zero
//    enforcement against your code.
//
// 2. Implementations reference contract types via JSDoc imports:
//      /** @typedef {import("./api.js").Ledger} Ledger */
//    Never copy-paste typedef bodies — always import.
//
// 3. Runtime values (constants, DDL strings, migrations) are re-exported
//    here. Type-only modules (schemas.js, api.js, tool-params.js,
//    tool-results.js, embeddings.js, jobs.js, events.js typedefs) are
//    referenced via `import("...")` JSDoc imports — they have no
//    runtime exports beyond the constants explicitly re-exported below.
//
// 4. Adding a new contract:
//      - Add the typedef to the right contract file (or create a new file).
//      - Re-export any runtime constants here.
//      - Bump the matching SCHEMA_VERSION when the change is breaking.
//      - Update the file headers' DECISIONS sections if a locked
//        decision changed (requires an RFC, not a contract bump).
//
// 5. Path canonicalization: every contract that names a file path means
//    repo-relative, forward-slash, normalized form. See schemas.js
//    header for the precise definition.

// ----------------------------------------------------------------------------
// Runtime exports.
// ----------------------------------------------------------------------------

export { ATLAS_EVENTS, ATLAS_EVENT_NAMES } from "./events.js";
export {
  LEDGER_DDL,
  VIEW_DDL,
  LEDGER_SCHEMA_VERSION,
  VIEW_SCHEMA_VERSION,
} from "./ddl/index.js";
export { HOST_MIGRATIONS } from "./ddl/host-migrations/index.js";
export {
  ATLAS_WARM_JOB_POLICY,
  ATLAS_WARM_JOB_TYPE,
} from "./jobs.js";
export {
  ATLAS_TOOL_ACTIONS,
} from "./tool-params.js";
export {
  ATLAS_TOOL_RESULT_SCHEMA_VERSION,
  ATLAS_TOOL_RESULT_FIELD_CATALOG,
  atlasResultData,
  atlasResultField,
  atlasResultFieldPath,
  atlasSymbolCardField,
  atlasValueAtPath,
} from "./tool-results.js";

// ----------------------------------------------------------------------------
// Type-only modules (referenced via JSDoc import):
//   ./schemas.js           SymbolRow, EdgeRow, LedgerEntry, BranchRecord, ViewMeta, ParseResult
//   ./api.js               Ledger, View, ViewBuilder, ParserAdapter, Indexer
//   ./tool-params.js       <Tool>Params, ToolCall, AtlasToolAction
//   ./tool-results.js      <Tool>Data, ToolResultEnvelope, ToolError, ToolResultMap
//   ./jobs.js              AtlasWarmJobPayload, AtlasWarmJobResult
//   ./events.js            AtlasEventName, AtlasEventPayload, AtlasOutboxRow
//   ./embeddings.js        EmbeddingRow, EmbeddingHit, EmbeddingIndex, EmbeddingEncoder
// ----------------------------------------------------------------------------
