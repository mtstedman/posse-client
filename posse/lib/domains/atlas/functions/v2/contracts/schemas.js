// @ts-check
//
// ATLAS v2 data shapes. Pure JSDoc typedefs — no runtime exports.
// Phase 1 implementations reference these via:
//   /** @typedef {import("./schemas.js").SymbolRow} SymbolRow */
//
// ============================================================================
// DECISIONS (locked at Phase 0.5 — do not relitigate without an RFC)
// ============================================================================
//
// 1. Symbol identity is content-addressed: `(content_hash, local_id)`.
//    A blob's parsed symbols are immutable once ingested. The same bytes
//    parsed in two different worktrees produce the same identities, which
//    is what lets us share results across worktrees without coordination.
//
// 2. The ledger is FILE-LEVEL, not symbol-level. One row per changed file
//    on a branch. Symbol-level diffs are derived at view-build time by
//    comparing `blob_symbols(before)` against `blob_symbols(after)`.
//    Reasoning: keeps append rate low, and one commit produces one row
//    per touched file regardless of how many symbols moved inside it.
//
// 3. `global_id` (used in View typedefs) is VIEW-LOCAL. It is an
//    autoincrement integer assigned during view materialization. NEVER
//    persist `global_id` outside its owning view DB — it has no meaning
//    across views and is not stable across rebuilds. Stable cross-view
//    identity is always `(content_hash, local_id)`.
//
// 4. Path canonicalization: every path in ATLAS v2 is repo-relative, forward
//    slashes, no leading "./", no trailing "/", never absolute, never
//    starts with "..", never empty. Matches `normalizeRepoPath` already
//    used in `worktree-lifecycle.js`. Producers normalize at the boundary;
//    consumers may assume the form.
//
// 5. Storage layout: one ledger DB per repo at `<repo>/.posse/atlas/ledger.db`.
//    One view DB per consumer (worktree or warmed slot). Views are
//    rebuildable caches, never authoritative.
//
// 6. Module path: ATLAS v2 lives at `lib/domains/atlas/functions/v2/...` (functions)
//    and `lib/domains/atlas/classes/v2/...` (classes). Both trees use the same
//    `atlas/v2` namespace shape; do not introduce another function-side
//    spelling.
//
// ============================================================================
//
// Canonical path form used everywhere in ATLAS v2:
//   - Forward slashes only.
//   - No leading "./", no trailing "/".
//   - Never absolute, never starts with "..".
//   - Empty string is not a valid path.
// The `normalizeRepoPath` helper already used in worktree-lifecycle.js defines
// the same shape; Phase 1 stores must accept only paths matching that form.

/**
 * A parsed symbol within a file blob.
 *
 * Identity is `(content_hash, local_id)` — stable as long as the blob bytes
 * are unchanged, regardless of which branch or worktree the blob came from.
 * This is what lets us share parsed results across worktrees.
 *
 * @typedef {Object} SymbolRow
 * @property {string} content_hash    SHA-256 (hex) of the file's bytes. Keys the blob this symbol lives in.
 * @property {number} local_id        0-based index assigned during parse; unique within the blob.
 * @property {SymbolKind} kind
 * @property {string} name            Short identifier as it appears in source.
 * @property {string | null} qualified_name  Dotted/colon-separated fully qualified form, when the language has one.
 * @property {number | null} parent_local_id Enclosing symbol's local_id (method → class, nested class → outer class).
 * @property {string} repo_rel_path   Canonical repo-relative path (see file header).
 * @property {string} lang            Lowercase language tag: "ts" | "js" | "py" | "rs" | "go" | "java" | "cs" | "cpp" | "c" | "php" | "kt" | "sh".
 * @property {number} range_start     Character offset of declaration start, into the file's UTF-8-decoded source string.
 * @property {number} range_end       Character offset of declaration end, exclusive. (Both indices are JS string char positions, NOT byte offsets — for pure-ASCII files they're identical, but multibyte characters shift them.)
 * @property {number} range_start_line 1-based line number of `range_start`. Computed at parse time from the source string. Stored so retrieval can emit real line anchors without re-reading file bytes.
 * @property {number} range_end_line   1-based line number of the character at `range_end - 1` (inclusive end-of-declaration line). For single-line declarations this equals `range_start_line`.
 * @property {string} signature_hash  SHA-256 (hex) of the normalized signature. Used for "modify" detection — name preserved, signature changed.
 * @property {string | null} [signature_text]  Raw signature text (first line of declaration, capped). Optional for backward compatibility — legacy rows have NULL.
 * @property {string | null} [body_identifiers]  Deduped identifier-token bag extracted from the symbol body for lexical "uses" search. Optional for legacy/SCIP rows.
 * @property {SymbolVisibility | null} visibility
 * @property {string | null} doc      Documentation string verbatim, or null. May be long.
 * @property {"treesitter" | "scip"} [source]  Backend that produced this row. Defaults to "treesitter" when omitted; producers that get their rows from a SCIP indexer set "scip". Used by the view builder to skip SCIP rows in the heuristic resolver pass.
 */

/**
 * @typedef {"function" | "method" | "class" | "interface" | "type" | "enum"
 *   | "const" | "var" | "module" | "namespace" | "trait" | "struct" | "macro"} SymbolKind
 */

/**
 * @typedef {"public" | "private" | "protected" | "internal"} SymbolVisibility
 */

/**
 * A cross-symbol reference discovered during parse or pass2 resolution.
 *
 * Edges are stored *per source blob* — `(content_hash, edge_id)` is unique
 * within that blob. The destination can be unresolved (resolver returns a
 * name but couldn't bind to a concrete symbol); in that case `to_content_hash`
 * and `to_local_id` are null and `to_name` carries the unresolved reference.
 *
 * @typedef {Object} EdgeRow
 * @property {string} from_content_hash   Source blob (where the edge appears).
 * @property {number} from_local_id       Source symbol's local_id in `from_content_hash`.
 * @property {number} edge_id             0-based index within the source blob.
 * @property {string | null} to_content_hash  Target blob, if resolved.
 * @property {number | null} to_local_id      Target symbol's local_id in `to_content_hash`, if resolved.
 * @property {string} to_name             The name being referenced. Always populated, even when resolved.
 * @property {string | null} [to_module]
 *   For import-kind edges, the source module string verbatim from the
 *   declaration (e.g. `"./bar.js"`, `"std::fmt::Display"`). The resolver
 *   joins this against the source blob's repo_rel_path to find the
 *   target file and bind the imported name to a concrete symbol. Null
 *   for non-import edges or import edges whose grammar didn't expose a
 *   source string (PHP `use Foo\Bar` carries the qualified name in
 *   `to_name` directly).
 * @property {EdgeKind} kind
 * @property {number} range_start         Character offset of the reference site in the source blob (JS string index, same convention as SymbolRow).
 * @property {number} range_end           Character offset (exclusive).
 * @property {number} range_start_line    1-based line number of `range_start`. Computed at parse time. Stored so caller/callee hits can carry real line anchors.
 * @property {number} range_end_line      1-based line number of the character at `range_end - 1`. Equals `range_start_line` for single-line references.
 * @property {number} confidence          Integer 0..100. 100 = parser-asserted, lower = heuristic pass2 resolution.
 * @property {number | null} [to_external_id]  Pointer into `external_symbols(id)` when the edge target is a SCIP-bound moniker outside the repo. Mutually exclusive with `(to_content_hash, to_local_id)`.
 * @property {string | null} [external_descriptor]  Denormalized SCIP descriptor for display when `to_external_id` is set. Lifted into view edges so retrieval doesn't need a JOIN on the hot path.
 * @property {"treesitter" | "scip"} [source]  Backend that produced this row. Defaults to "treesitter" when omitted.
 */

/**
 * @typedef {"calls" | "references" | "extends" | "implements"
 *   | "uses_type" | "imports" | "throws" | "reads" | "writes"} EdgeKind
 */

/**
 * One file-level change appended to the ledger.
 *
 * The ledger is intentionally file-level, not symbol-level. Symbol-level
 * deltas are derived by diffing `blob_symbols(before)` against
 * `blob_symbols(after)` at view-build time. Keeping ledger entries coarse
 * keeps the append rate low and lets multiple symbol changes in one commit
 * share a single row.
 *
 * @typedef {Object} LedgerEntry
 * @property {number} seq                 Monotonic per `branch`. Assigned by `Ledger.append`.
 * @property {string} branch              Branch this delta belongs to. `main` is special.
 * @property {string} ts                  ISO-8601 timestamp with millis.
 * @property {LedgerOp} op
 * @property {string} repo_rel_path       Canonical repo-relative path.
 * @property {string | null} before_content_hash  Null for `op === "add"`.
 * @property {string | null} after_content_hash   Null for `op === "remove"`.
 * @property {number | null} parent_seq   Previous seq on the same branch that touched this path, if any. Lets view-apply walk path history without a full scan.
 */

/**
 * @typedef {"add" | "remove" | "modify"} LedgerOp
 */

/**
 * Branch lineage metadata stored alongside the ledger.
 *
 * Every branch other than `main` has a parent. Forking a branch at seq N
 * means "this branch sees parent's history up to and including seq N, then
 * its own appends from seq N+1 onward." Merge-to-main replays the child
 * branch's partition onto main's partition.
 *
 * @typedef {Object} BranchRecord
 * @property {string} name
 * @property {string | null} parent_branch     Null only for `main`.
 * @property {number | null} parent_seq        Parent branch seq at fork time. Null only for `main`.
 * @property {string} created_at               ISO-8601.
 * @property {BranchStatus} status
 */

/**
 * @typedef {"active" | "merged" | "abandoned"} BranchStatus
 */

/**
 * Metadata embedded in a built view DB so any reader can verify what it has.
 *
 * Lives in the view DB's `meta` table as JSON-encoded values. Read via
 * `View.mount(path).meta()`.
 *
 * @typedef {Object} ViewMeta
 * @property {number} schema_version          Bumped when view DDL changes.
 * @property {string} branch                  Branch this view represents.
 * @property {string | null} parent_branch    Lineage for delta replay.
 * @property {number | null} parent_seq       Parent seq at fork time.
 * @property {number} ledger_seq              Highest ledger seq applied to this view from `branch`'s partition.
 * @property {string} built_at                ISO-8601 of the build that produced the current state.
 * @property {string[] | null} warmed_for_files  Hint paths used for prefetch warming, if any.
 * @property {number | null} prefetched_symbols Count of symbols visited during hint-driven neighborhood prefetch. Null when no hint was supplied at build time.
 * @property {number | null} prefetched_edges  Count of edges traversed during hint-driven neighborhood prefetch. Null when no hint was supplied at build time.
 * @property {string | null} repo_root        Absolute path to the repo at build time. Informational only — never used as a key.
 * @property {boolean} layer_merge             True when the view was materialized from merged tree-sitter/SCIP layers.
 */

/**
 * Parser output for a single file. Producers are language adapters under
 * `lib/domains/atlas/functions/v2/parser/`. Consumers are `Indexer` and tests.
 *
 * @typedef {Object} ParseResult
 * @property {string} repo_rel_path
 * @property {string} content_hash
 * @property {string} lang
 * @property {SymbolRow[]} symbols
 * @property {EdgeRow[]} edges
 * @property {boolean} [hasError] True when tree-sitter recovered from syntax errors.
 */

/**
 * A SCIP moniker stored in the ledger's `external_symbols` table. One row
 * per unique cross-repo / library symbol referenced from any blob.
 *
 * Identity is the full tuple — nullable fields use `''` as a sentinel
 * because SQLite UNIQUE treats NULL as always distinct. Producers should
 * normalize before passing values into `Ledger.upsertExternalSymbol`.
 *
 * @typedef {Object} ExternalSymbol
 * @property {number} id
 * @property {string} scheme            e.g. "scip-typescript", "scip-java"
 * @property {string} manager           e.g. "npm", "maven", "gomod"; "" for stdlib.
 * @property {string} package_name      e.g. "@types/node".
 * @property {string} package_version   "" when the version is unknown.
 * @property {string} descriptor        Raw SCIP descriptor path.
 * @property {string | null} display_name  Short identifier suitable for UI rendering. Optional.
 */

/**
 * Bookkeeping row produced once per ingested `.scip` file. The (scheme,
 * indexer_version, fileset_hash, config_hash, deps_hash) tuple is unique
 * so re-ingesting the same indexer output is a no-op.
 *
 * @typedef {Object} ScipIndexRecord
 * @property {number} id
 * @property {string} scheme
 * @property {string} tool_name
 * @property {string} indexer_version
 * @property {string[]} indexer_arguments
 * @property {string} project_root
 * @property {string} langs                 Comma-separated language tags.
 * @property {string} fileset_hash          SHA-256 of sorted [repo_rel_path, content_hash] input pairs.
 * @property {string} config_hash           SHA-256 of (tsconfig|go.mod|pom.xml|...). "" when not provided.
 * @property {string} deps_hash             SHA-256 of (package-lock|go.sum|...). "" when not provided.
 * @property {number} document_count
 * @property {number} occurrence_count
 * @property {number} external_symbol_count
 * @property {string | null} produced_at    ISO-8601 from the .scip file, when available.
 * @property {string} ingested_at           ISO-8601 of the consume.
 */

export {};
