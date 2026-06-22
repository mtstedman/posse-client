// @ts-check
//
// ATLAS v2 public interfaces. Pure JSDoc typedefs — no runtime values.
//
// Phase 1 implementations declare conformance via JSDoc, e.g.:
//
//   /** @typedef {import("./api.js").Ledger} Ledger */
//   /** @implements {Ledger} */
//   implementation module: SqliteLedger
//
// These typedefs are the *only* coupling between Phase 1 workstreams.
// Implementations may extend them with private surface, but the public
// shape must match exactly.

/** @typedef {import("./schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("./schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("./schemas.js").LedgerEntry} LedgerEntry */
/** @typedef {import("./schemas.js").LedgerOp} LedgerOp */
/** @typedef {import("./schemas.js").BranchRecord} BranchRecord */
/** @typedef {import("./schemas.js").ViewMeta} ViewMeta */
/** @typedef {import("./schemas.js").ParseResult} ParseResult */
/** @typedef {import("./embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("./embeddings.js").EmbeddingEncoder} EmbeddingEncoder */

// ============================================================================
// Ledger — append-only file-level delta log + content-addressable blob store.
// Workstream A owns the implementation at lib/domains/atlas/classes/v2/Ledger.js.
// ============================================================================

/**
 * @typedef {Object} LedgerAppendInput
 * @property {string} branch
 * @property {LedgerOp} op
 * @property {string} repo_rel_path
 * @property {string | null} before_content_hash
 * @property {string | null} after_content_hash
 */

/**
 * @typedef {Object} BlobIngest
 * @property {string} content_hash
 * @property {string} lang
 * @property {number} byte_size
 * @property {SymbolRow[]} symbols
 * @property {EdgeRow[]} edges
 */

/**
 * @typedef {Object} Ledger
 *
 * @property {(input: LedgerAppendInput) => LedgerEntry} append
 *   Append one delta to the named branch's partition. Assigns `seq` and
 *   `ts`, resolves `parent_seq` from the previous entry on this branch
 *   that touched the same path. Returns the materialized entry.
 *   Throws if `branch` does not exist.
 *
 * @property {(blob: BlobIngest) => void} ingestBlob
 *   Idempotently store a parsed blob and its symbols/edges. Safe to call
 *   from multiple workers — if the content_hash already exists, this is a
 *   no-op. This is the *only* path symbols enter the system.
 *
 * @property {(content_hash: string) => boolean} hasBlob
 *
 * @property {(content_hash: string) => boolean} [hasCurrentParsedBlob]
 *   True when the content-addressed blob has parser rows written by the
 *   current parser/spec version. Warm jobs use this to skip tree-sitter for
 *   unchanged files while still reparsing stale cached output after upgrades.
 *
 * @property {(branch: string, fromSeq: number, options?: { limit?: number, upToSeq?: number } | number) => LedgerEntry[]} tail
 *   Read deltas on `branch` strictly after `fromSeq`, in seq order.
 *   The third argument is either a numeric `limit` (legacy) or an
 *   options object with `{ limit?, upToSeq? }`. `limit` defaults to
 *   unlimited; `upToSeq` (inclusive upper bound) is used by ViewBuilder
 *   when walking branch lineage with fork cutoffs.
 *
 * @property {(branch: string) => number} headSeq
 *   Highest seq on `branch`, or 0 if the branch has no deltas.
 *
 * @property {(name: string, parentBranch: string, atSeq: number) => BranchRecord} forkBranch
 *   Create a new branch whose lineage starts at `(parentBranch, atSeq)`.
 *   The new branch starts with seq 0 of its own partition; reads "see"
 *   parent history up to `atSeq` via the View layer.
 *   Throws if `name` already exists or `parentBranch` does not.
 *
 * @property {(name: string) => BranchRecord} ensureRootBranch
 *   Ensure a root branch exists without assuming the configured git target is
 *   literally named "main".
 *
 * @property {(name: string) => BranchRecord | null} getBranch
 *
 * @property {(name: string, status: "merged" | "abandoned") => void} setBranchStatus
 *
 * @property {(branch: string, ontoBranch: string, fromSeq: number) => LedgerEntry[]} replayPartition
 *   Replay `branch`'s deltas after `fromSeq` onto `ontoBranch` (typically
 *   `main`). Each replayed delta gets a fresh seq on the destination
 *   branch. Returns the appended entries on the destination.
 *
 * @property {(content_hash: string) => SymbolRow[]} getBlobSymbols
 *   Hydrate all symbols stored for a content-addressed blob, in
 *   local_id order. Returns empty when the blob is unknown.
 *   `repo_rel_path` on each row is empty — the ledger is path-agnostic
 *   per blob; pair with `pathSnapshotAt` if you need the path.
 *
 * @property {(branch: string, atSeq: number) => Map<string, string>} pathSnapshotAt
 *   Materialize the (repo_rel_path → content_hash) map for `branch` at
 *   or before `atSeq`, walking branch lineage. Removed paths are not
 *   present in the result. Used by delta computation in the retrieval
 *   port.
 *
 * @property {(input: FeedbackRecordInput) => number} recordFeedback
 *   Persist a batch of useful/missing feedback signals tied to a slice.
 *   Symbol identities are taken from the SymbolId string ("<hash>:<lid>").
 *   Malformed IDs are skipped, not raised. Returns the number of rows
 *   actually inserted.
 *
 * @property {(opts?: FeedbackQueryOptions) => FeedbackAggregate[]} recentFeedback
 *   Aggregate recent feedback rows into per-symbol totals. Used by the
 *   retrieval orchestrator's feedback-boost pass. Rows older than
 *   `sinceTs` (default: 30 days ago) are excluded. When `taskType` is
 *   set, only signals recorded against that task type contribute.
 *
 * @property {() => void} close
 */

/**
 * @typedef {Object} FeedbackRecordInput
 * @property {string} [sliceHandle]               Opaque handle for cross-referencing the originating slice.
 * @property {string[]} [usefulSymbolIds]         "<content_hash>:<local_id>" strings.
 * @property {string[]} [missingSymbolIds]        "<content_hash>:<local_id>" strings.
 * @property {string} [taskType]                  Free-form task type (e.g. "debug").
 * @property {string} [taskText]                  Abbreviated task description; truncated by the writer.
 */

/**
 * @typedef {Object} FeedbackQueryOptions
 * @property {string} [sinceTs]                   ISO-8601; rows older than this are excluded.
 * @property {string} [taskType]                  Filter to one task type.
 * @property {string} [taskText]                  Optional current task text; when present, rows with
 *                                                unrelated prior task_text are filtered before aggregation.
 * @property {number} [limit]                     Max rows to scan; default 5000.
 * @property {number} [halfLifeDays]              When set, returned aggregates carry `useful_weight` /
 *                                                `missing_weight` with each signal weighted by
 *                                                `exp(-age_days / halfLifeDays)`. Counts are still
 *                                                returned unchanged so telemetry stays comparable.
 * @property {(detail: { taskText: string, prior_task_text: string | null, score: number | null, included_in_filter: boolean, threshold: number, reason?: string }) => void} [onTaskTextMatch]
 *                                                Optional row-level observer for task-text filter tuning.
 */

/**
 * @typedef {Object} FeedbackAggregate
 * @property {string} content_hash
 * @property {number} local_id
 * @property {number} useful_count
 * @property {number} missing_count
 * @property {number} [useful_weight]             Present when halfLifeDays was set. Decayed sum.
 * @property {number} [missing_weight]            Present when halfLifeDays was set. Decayed sum.
 * @property {string} last_ts                     Most recent signal in the window, ISO-8601.
 */

// ============================================================================
// View — read-side materialized projection of the ledger.
// Workstream B owns the implementation at lib/domains/atlas/classes/v2/View.js.
// ============================================================================

/**
 * A symbol as returned by view queries — denormalized for display and
 * downstream consumers. global_id is local to this view instance.
 *
 * @typedef {Object} ViewSymbol
 * @property {number} global_id
 * @property {string} content_hash
 * @property {number} local_id
 * @property {string} kind
 * @property {string} name
 * @property {string | null} qualified_name
 * @property {string} repo_rel_path
 * @property {number} range_start
 * @property {number} range_end
 * @property {number} range_start_line   1-based line number of `range_start`. Mirrors the column persisted by the ledger/view; 1 indicates a legacy row indexed before line columns were added.
 * @property {number} range_end_line     1-based line number of the character at `range_end - 1`.
 * @property {string} signature_hash
 * @property {string | null} signature_text  Raw signature text (capped at parser time). Nullable for legacy pre-signature-text rows.
 * @property {string | null} [body_identifiers] Deduped identifier-token bag for lexical body/uses search.
 * @property {string | null} visibility
 * @property {string | null} doc
 * @property {string} lang
 */

/**
 * An edge as returned by view queries.
 *
 * @typedef {Object} ViewEdge
 * @property {number} from_global_id
 * @property {number | null} to_global_id      Null when unresolved.
 * @property {string} to_name
 * @property {string | null} [to_module]       Source-module string for import edges.
 * @property {number | null} [to_external_id]  Non-null when bound to an external SCIP moniker.
 * @property {string | null} [external_descriptor] Denormalized SCIP descriptor for external edges.
 * @property {"treesitter" | "scip"} [source]  Backend that produced this edge.
 * @property {string} kind
 * @property {string} repo_rel_path
 * @property {number} range_start
 * @property {number} range_end
 * @property {number} range_start_line   1-based line number of `range_start`. Legacy rows default to 1.
 * @property {number} range_end_line     1-based line number of the character at `range_end - 1`.
 * @property {number} confidence
 */

/**
 * @typedef {Object} SymbolSearchOptions
 * @property {number} [limit]              Default 50.
 * @property {string[]} [kinds]            Filter by symbol kind.
 * @property {string[]} [langs]            Filter by language.
 * @property {string} [pathPrefix]         Canonical repo-relative prefix filter.
 * @property {boolean} [fuzzy]             FTS prefix/fuzzy search. Default true.
 * @property {"name" | "body" | "either"} [scope]  Search symbol names, symbol bodies, or both. Default "either".
 */

/**
 * @typedef {Object} SliceOptions
 * @property {number} [depth]              Hops out from seeds. Default 2.
 * @property {("calls" | "references" | "extends" | "implements" | "uses_type" | "imports")[]} [edgeKinds]
 * @property {number} [maxSymbols]         Hard cap on returned symbols. Default 200.
 * @property {number} [minConfidence]      Minimum edge confidence in [0, 1] or [0, 100].
 */

/**
 * @typedef {Object} ViewQuery
 *
 * @property {(name: string, opts?: SymbolSearchOptions) => ViewSymbol[]} findSymbol
 *
 * @property {(global_id: number) => ViewSymbol | null} getSymbol
 *
 * @property {(repo_rel_path: string) => ViewSymbol[]} symbolsInFile
 *
 * @property {(global_id: number) => ViewEdge[]} callers
 *   Resolved edges where `to_global_id === global_id`.
 *
 * @property {(global_id: number) => ViewEdge[]} callees
 *   Resolved edges where `from_global_id === global_id`.
 *
 * @property {(name: string) => ViewEdge[]} unresolvedReferencesTo
 *   Edges with no internal or external binding and `to_name = name`. Useful
 *   when adding a new declaration to find latent references.
 *
 * @property {(seedGlobalIds: number[], opts?: SliceOptions) => ViewSymbol[]} slice
 *   N-hop symbol neighborhood starting from `seedGlobalIds`.
 *
 * @property {(seedGlobalIds: number[], opts?: SliceOptions) => { symbols: ViewSymbol[], frontier: { symbol: ViewSymbol, score: number, why: string }[] }} [sliceWithMetadata]
 *   Weighted neighborhood plus top not-yet-included expansion candidates.
 *
 * @property {(paths: string[]) => ViewSymbol[]} blastRadius
 *   All symbols that transitively reference any symbol defined in any of
 *   the given files. Used by assessor / planner to scope reviews.
 *
 * @property {(content_hash: string, local_id: number) => ViewSymbol | null} getByContentLocal
 *   Look up a single symbol by its stable cross-view identity
 *   `(content_hash, local_id)`. The view-local `global_id` is unstable,
 *   so retrieval handlers that receive a SymbolId — encoded as
 *   `"<content_hash>:<local_id>"` — use this to resolve back to a
 *   ViewSymbol regardless of which view was queried last.
 *
 * @property {(opts?: { limit?: number, pathPrefix?: string }) => ViewSymbol[]} allSymbols
 *   Enumerate every symbol in the view. Used by stats, overview, and
 *   delta computation where FTS-based search cannot guarantee full
 *   coverage. Callers should pass a `limit` for large views; consumers
 *   that need streaming should add a paging variant rather than abusing
 *   this one.
 */

/**
 * @typedef {Object} View
 *
 * @property {() => ViewMeta} meta
 *
 * @property {ViewQuery} query
 *
 * @property {() => void} close
 */

// ============================================================================
// ViewBuilder — produce a view from a ledger.
// Workstream B owns the implementation at
// lib/domains/atlas/classes/v2/ViewBuilder.js. Workstream F (warmer) is the primary
// caller.
// ============================================================================

/**
 * Prefetch hint for `ViewBuilder.buildFrom`. Honors the spec primitive
 * `build_view(at_seq, hint?)` from PORT-PLAN section 3.4 — when supplied,
 * the builder walks the symbol neighborhood around `paths` after the view
 * is materialized, touching index + leaf pages so they land in the OS
 * page cache before the worker mounts the view. The view itself is always
 * complete (the rebuildable-from-ledger invariant from 3.3 is preserved);
 * the hint only controls which subset gets pre-warmed.
 *
 * @typedef {Object} BuildHint
 * @property {string[]} paths               Canonical repo-relative paths whose symbol neighborhood should be prefetched.
 * @property {number} [depth]               Edge hops out from seeds. Default 2. Clamped to [1, 4].
 * @property {number} [maxSymbols]          Hard cap on prefetched symbols. Default 500. Clamped to [1, 5000].
 */

/**
 * @typedef {Object} BuildOptions
 * @property {string[]} [warmedForFiles]    Prefetch hint paths to record in ViewMeta. Legacy — prefer `hint`, which both records paths and runs the prefetch pass.
 * @property {BuildHint} [hint]             When set, runs a neighborhood prefetch pass after the view is built. Activates the 3.4 active warming behavior.
 * @property {string} [repoRoot]            Absolute path to record in ViewMeta (informational only).
 * @property {boolean} [layerMerge]         When true, materialize merged SCIP/tree-sitter layer rows instead of the legacy flat blob rows.
 * @property {"off" | "deterministic" | "ml"} [treeCompressionMode] Controls cached ATLAS tree seed compression during view build.
 * @property {number} [treeCompressionMaxSeeds] Maximum deterministic tree compression seeds to store.
 */

/**
 * @typedef {Object} ViewBuilder
 *
 * @property {(args: {
 *   ledger: Ledger,
 *   branch: string,
 *   atSeq: number,
 *   outPath: string,
 *   options?: BuildOptions,
 *   onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null,
 * }) => ViewMeta} buildFrom
 *   Build a view at `outPath` that represents `branch` at `atSeq`. The
 *   file at `outPath` must not exist; builder creates it. Walks branch
 *   lineage to assemble path_to_blob, then materializes all reachable
 *   symbols and edges. Returns the final ViewMeta.
 *
 * @property {(args: {
 *   view: View,
 *   ledger: Ledger,
 *   entries: LedgerEntry[],
 *   onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null,
 * }) => ViewMeta} incrementalApply
 *   Apply `entries` (all from the same branch, in seq order, all with seq
 *   greater than `view.meta().ledger_seq`) to an already-built view.
 *   Mutates the view DB. Returns updated ViewMeta.
 *
 * @property {(args: {
 *   sourcePath: string,
 *   destPath: string,
 * }) => void} cloneView
 *   Filesystem-level copy of a view file. Used by the warmer for the
 *   "fork from main" fast path. Destination must not exist.
 */

// ============================================================================
// ParserAdapter — language-specific file → ParseResult.
// Workstream C owns the implementation under
// lib/domains/atlas/functions/v2/parser/. Wraps vendored atlas-mcp parsers.
// ============================================================================

/**
 * @typedef {Object} ParserAdapter
 *
 * @property {(args: {
 *   absPath: string,
 *   repoRoot: string,
 * }) => Promise<ParseResult>} parseFile
 *   Parse one file. Internally:
 *     1. Read bytes, compute content_hash.
 *     2. Compute repo_rel_path = normalizeRepoPath(absPath relative to repoRoot).
 *     3. Dispatch to the language-specific parser by extension.
 *     4. Return ParseResult with all paths in canonical form.
 *   Throws on unsupported languages — caller decides whether to skip.
 *
 * @property {(extOrLang: string) => boolean} supports
 *   True if the adapter can parse files with the given extension
 *   (".ts") or language tag ("ts"). Used by walkers to skip unsupported
 *   files without throwing.
 *
 * @property {() => string[]} languages
 *   Languages this adapter supports. Lowercase tags matching SymbolRow.lang.
 *
 * @property {(args: { bytes: Buffer | string, repo_rel_path: string, lang?: string }) => ParseResult} [parseBuffer]
 *   Optional zero-copy entry point used by warm jobs after they have already
 *   read bytes to compute the content hash.
 */

// ============================================================================
// Indexer — file-list → ledger appends. Coordinator over ParserAdapter and
// Ledger. Workstream C and Workstream A both implement pieces of this;
// the wiring lives at lib/domains/atlas/classes/v2/Indexer.js.
// ============================================================================

/**
 * @typedef {Object} IndexRequest
 * @property {string} repoRoot              Absolute path to the repo or worktree.
 * @property {string} branch                Branch to append deltas to.
 * @property {string[]} relPaths            Canonical repo-relative paths to (re)index.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} IndexReport
 * @property {LedgerEntry[]} entries        Deltas appended (one per changed path).
 * @property {string[]} skipped             Paths skipped for unsupported language.
 * @property {{ path: string, error: string }[]} errors
 * @property {number} parsedBlobs           Count of newly ingested blob content_hashes.
 * @property {number} reusedBlobs           Count of paths whose content_hash already had a blob.
 */

/**
 * @typedef {Object} Indexer
 *
 * @property {(req: IndexRequest) => Promise<IndexReport>} indexPaths
 *   For each path in `relPaths`:
 *     1. Read file bytes, compute content_hash.
 *     2. If `Ledger.hasBlob(content_hash)`, reuse. Otherwise parse and ingest.
 *     3. Compare against branch's current head for that path; append the
 *        appropriate add/remove/modify delta. Skip if no-op.
 *   Returns a summary. Errors per-file do not abort the batch.
 */

export {};
