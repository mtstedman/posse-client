// @ts-check
//
// Input parameter typedefs for every ATLAS v2 public tool. Mirrors the
// existing posse tool-descriptors and the atlas-mcp gateway schemas.
//
// The set is frozen — adding a new tool requires updating:
//   1. ATLAS_TOOL_DEFS in lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js
//   2. The matching `<Tool>Params` typedef here
//   3. The matching `<Tool>Result` typedef in tool-results.js
//   4. The dispatch table that maps action -> handler in the v2 server
//
// Authority on field semantics is the atlas-mcp gateway schemas. When in
// doubt, treat the existing zod schemas as the spec.

// ============================================================================
// Shared / utility shapes
// ============================================================================

/**
 * @typedef {Object} SliceBudget
 * @property {number} [maxCards]              1..500
 * @property {number} [maxEstimatedTokens]    1..200000
 */

/**
 * Used by symbol.card when the caller doesn't have a symbol ID yet.
 * Exactly one of `symbolId` or `symbolRef` must be set.
 *
 * @typedef {Object} SymbolRef
 * @property {string} name
 * @property {string} [file]                  Canonical repo-relative path.
 * @property {string} [kind]
 * @property {boolean} [exportedOnly]
 */

/** @typedef {"minimal" | "signature" | "deps" | "compact" | "full"} CardDetail */
/** @typedef {"standard" | "compact" | "agent" | "packed"} WireFormat */
/** @typedef {1 | 2 | 3} WireFormatVersion */
/** @typedef {"symbol" | "block" | "fileWindow"} CodeGranularity */
/** @typedef {"cluster" | "process"} TreeRefType */
/** @typedef {"stats" | "directories" | "hotspots" | "graph" | "full"} OverviewLevel */
/** @typedef {"minimal" | "standard" | "full"} StatusDetail */
/** @typedef {"precise" | "broad"} ContextMode */
/** @typedef {"debug" | "review" | "implement" | "explain"} TaskType */
/** @typedef {import("./runtimes.js").AtlasRuntimeInput} AtlasRuntimeInput */

// ============================================================================
// gateway wrappers — Compact native routing surfaces
// ============================================================================

/**
 * Direct dispatch uses `targetAction`; MCP/provider gateway adapters accept
 * an `action` argument and rewrite it to `gatewayAction` before dispatch so
 * the wrapper action itself remains visible to the router.
 *
 * @typedef {Object} GatewayParams
 * @property {string} [targetAction]
 * @property {string} [gatewayAction]
 */

// ============================================================================
// action.search / manual — Native ATLAS v2 discovery
// ============================================================================

/**
 * @typedef {Object} ActionSearchParams
 * @property {string} [query]
 * @property {string} [namespace]
 * @property {number} [limit]
 * @property {number} [offset]
 */

/**
 * @typedef {Object} ManualParams
 * @property {string} [query]
 * @property {string[]} [actions]
 * @property {number} [limit]
 * @property {boolean} [includeSchemas]
 * @property {boolean} [includeExamples]
 * @property {"text" | "json"} [format]
 */

// ============================================================================
// workflow — Native multi-step ATLAS action runner
// ============================================================================

/**
 * @typedef {Object} WorkflowStepParams
 * @property {string} [id]                    Optional reference id for later `$id.path` lookups.
 * @property {string} [fn]                    CamelCase function name or transform name.
 * @property {string} [action]                Canonical ATLAS action name; preferred when available.
 * @property {Record<string, unknown>} [args] Step args. Exact string refs like `$0.items[0].symbolId` are resolved.
 * @property {number} [maxResponseTokens]     Optional response truncation cap for this step.
 */

/**
 * @typedef {Object} WorkflowBudgetParams
 * @property {number} [maxTotalTokens]
 * @property {number} [maxSteps]
 * @property {number} [maxDurationMs]
 */

/**
 * @typedef {Object} WorkflowTraceParams
 * @property {"summary" | "verbose"} [level]
 * @property {boolean} [includeResolvedArgs]
 * @property {number} [maxPreviewTokens]
 */

/**
 * @typedef {Object} WorkflowParams
 * @property {string} [repoId]
 * @property {WorkflowStepParams[]} steps
 * @property {WorkflowBudgetParams} [budget]
 * @property {"continue" | "stop"} [onError]
 * @property {number} [defaultMaxResponseTokens]
 * @property {boolean} [onlyFinalResult]
 * @property {WorkflowTraceParams} [trace]
 * @property {boolean} [dryRun]
 */

// ============================================================================
// info — Native ATLAS v2 diagnostics
// ============================================================================

/**
 * @typedef {Object} InfoParams
 * @property {string} [repoId]
 * @property {boolean} [includePolicy]
 * @property {boolean} [includeCounts]
 */

// ============================================================================
// repo.* — Repository status and overview
// ============================================================================

/**
 * @typedef {Object} RepoRegisterParams
 * @property {string} [repoId]
 * @property {string} [repoRoot]              Absolute repo root override; dispatch context repoRoot wins when present.
 * @property {string} [branch]                Baseline ledger branch. Defaults to the configured merge target.
 * @property {boolean} [buildEmptyView]       Default true; creates an empty main view on cold repos.
 */

/**
 * @typedef {Object} RepoStatusParams
 * @property {StatusDetail} [detail]
 * @property {boolean} [surfaceMemories]
 */

/**
 * @typedef {Object} IndexRefreshParams
 * @property {"smart" | "full" | "incremental"} [mode]
 * @property {string[]} [paths]               Canonical repo-relative paths for incremental refresh.
 * @property {string} [branch]                Defaults to the configured merge target.
 * @property {boolean} [wait]                 Default true in embedded v2; direct refresh returns the warm result.
 * @property {boolean} [async]                Request detached operation semantics when a caller supports them. Embedded v2 currently reports the request but completes synchronously.
 * @property {boolean} [includeDiagnostics]   Include operation phase timings and progress events.
 * @property {string} [operationId]           Optional caller-provided operation id for progress correlation.
 */

/**
 * @typedef {Object} RepoOverviewParams
 * @property {OverviewLevel} [level]
 * @property {boolean} [includeHotspots]
 * @property {string[]} [directories]         Repo-relative directory paths to focus on.
 * @property {number} [maxDirectories]
 * @property {number} [maxExportsPerDirectory]
 * @property {string} [ifNoneMatch]           ETag for conditional fetch.
 */

/**
 * @typedef {Object} RepoQualityParams
 * @property {boolean} [probeTreeSitter]      When true, attempt to load observed tree-sitter grammars.
 * @property {number} [feedbackLimit]         Max feedback aggregate rows to inspect for quality hints.
 * @property {number} [halfLifeDays]          Optional recency decay for feedback weights.
 */

// ============================================================================
// buffer.* — Live draft overlay
// ============================================================================

/**
 * @typedef {Object} BufferPushParams
 * @property {string} filePath                Canonical repo-relative path.
 * @property {string} content                 Full editor buffer content.
 * @property {string} [sessionId]             Optional editor/session namespace.
 * @property {number} [version]
 * @property {"open" | "change" | "save" | "close" | "checkpoint"} [eventType]
 * @property {string} [language]
 * @property {boolean} [dirty]
 * @property {string} [timestamp]
 * @property {{ line?: number, column?: number }} [cursor]
 * @property {Array<{ startLine?: number, startColumn?: number, endLine?: number, endColumn?: number }>} [selections]
 */

/**
 * @typedef {Object} BufferCheckpointParams
 * @property {string} filePath                Canonical repo-relative path.
 * @property {string} [sessionId]
 * @property {boolean} [writeToDisk]          When true, write overlay contents to disk before clearing.
 * @property {boolean} [clear]                Clear overlay even when disk differs.
 */

/**
 * @typedef {Object} BufferStatusParams
 * @property {string} [filePath]              Optional canonical repo-relative path filter.
 * @property {string} [sessionId]
 */

// ============================================================================
// symbol.* — Symbol discovery and card retrieval
// ============================================================================

/**
 * @typedef {Object} SymbolSearchParams
 * @property {string} query
 * @property {number} [limit]
 * @property {boolean} [semantic]             Enable semantic reranking (embeddings).
 * @property {("symbols" | "feedback")[]} [entities]
 *   Optional entity families to include. Default ["symbols"]; extra families
 *   are returned in SymbolSearchData.entities when feedback FTS is available.
 * @property {"name" | "body" | "either"} [scope] Search symbol names, symbol-body identifier tokens, or both. Default "either".
 * @property {string} [sessionId]             Optional live-buffer overlay namespace.
 */

/**
 * @typedef {Object} SymbolUsagesParams
 * @property {string} symbolId
 * @property {("calls" | "references" | "reads" | "writes" | "uses_type" | "imports" | "extends" | "implements")[]} [kind]
 * @property {number} [limit]
 * @property {number} [minConfidence]          0..1 or 0..100
 * @property {boolean} [includeUnresolved]
 */

/**
 * @typedef {Object} SymbolGetCardParams
 * @property {string} [symbolId]              Required iff symbolRef is absent.
 * @property {SymbolRef} [symbolRef]          Required iff symbolId is absent.
 * @property {string[]} [symbolIds]           Batch form; returns symbol.cards-shaped data.
 * @property {SymbolRef[]} [symbolRefs]       Batch form; returns symbol.cards-shaped data.
 * @property {string} [ifNoneMatch]
 * @property {number} [minCallConfidence]     0..1
 * @property {boolean} [includeResolutionMetadata]
 * @property {string} [sessionId]             Optional live-buffer overlay namespace.
 */

// ============================================================================
// tree.* — Tree-derived containment and aggregate views
// ============================================================================

/**
 * @typedef {Object} TreeOverviewParams
 * @property {string} [nodeId]                Exact atlas_tree_nodes.node_id.
 * @property {string} [path]                  Canonical repo-relative file or directory path.
 * @property {string} [symbolId]              Stable ATLAS symbol id/ref; can match multiple paths for duplicated blobs.
 * @property {TreeRefType} [refType]          Direct leaf ref lookup type.
 * @property {string} [refId]                 Cluster/process id for ref lookup.
 * @property {number} [maxDepth]              Descendant depth from focused node(s), default 1, max 8.
 * @property {number} [limit]                 Page size, default 100, max 500.
 * @property {number} [offset]                Page offset.
 * @property {boolean} [includeAggregates]    Include aggregate JSON on each node. Default true.
 * @property {boolean} [includeTerms]         Include generated terms on each node. Default false.
 * @property {boolean} [includeRefs]          Include direct cluster/process refs on returned nodes. Default false.
 * @property {boolean} [includeLatestRun]     Include latest tree-derived build run metadata. Default true.
 */

/**
 * @typedef {Object} TreeScopeParams
 * @property {string} [taskText]              Natural-language task/scope text.
 * @property {TaskType} [taskType]
 * @property {string[]} [paths]               Repo-relative file/dir seeds.
 * @property {string[]} [editedFiles]         Repo-relative file/dir seeds from known work scope.
 * @property {string} [path]                  Single repo-relative file/dir seed.
 * @property {string[]} [symbolIds]           Stable ATLAS symbol ids/refs.
 * @property {string} [symbolId]              Single stable ATLAS symbol id/ref.
 * @property {string[]} [nodeIds]             Exact atlas_tree_nodes.node_id seeds.
 * @property {Array<{ refType: TreeRefType, refId: string }>} [refs]
 * @property {TreeRefType} [refType]          Single cluster/process ref type.
 * @property {string} [refId]                 Single cluster/process ref id.
 * @property {number} [maxFiles]              Max candidate files returned. Default 40.
 * @property {number} [maxBranches]           Max accepted containment branches. Default 12.
 * @property {number} [branchFileCap]         Max files under one accepted branch. Default 40.
 * @property {number} [refMatchLimit]         Max ref matches to score before treating the ref as broad. Default 50.
 */

// ============================================================================
// slice.* — Bounded task-shaped retrieval
// ============================================================================

/**
 * @typedef {Object} SliceBuildParams
 * @property {string} [taskText]
 * @property {boolean} [semantic]             Enable semantic/vector entry discovery when configured.
 * @property {TaskType} [taskType]
 * @property {string} [stackTrace]
 * @property {string} [failingTestPath]       Canonical repo-relative path.
 * @property {string[]} [editedFiles]         Canonical repo-relative paths, max 100.
 * @property {string[]} [entrySymbols]        Symbol IDs, max 100.
 * @property {Record<string, string>} [knownCardEtags]  Up to 1000 entries.
 * @property {string} [ifNoneMatch]
 * @property {CardDetail} [cardDetail]
 * @property {boolean} [adaptiveDetail]
 * @property {WireFormat} [wireFormat]
 * @property {WireFormatVersion} [wireFormatVersion]
 * @property {SliceBudget} [budget]
 * @property {number} [minConfidence]         0..1
 * @property {number} [minCallConfidence]     0..1
 * @property {boolean} [includeResolutionMetadata]
 */

/**
 * @typedef {Object} SliceRefreshParams
 * @property {string} sliceHandle
 * @property {string} knownVersion
 */

/**
 * @typedef {Object} SliceSpilloverGetParams
 * @property {string} spilloverHandle
 * @property {string} [cursor]
 * @property {number} [pageSize]              1..100
 */

/**
 * @typedef {Object} EditPlanParams
 * @property {string} [taskText]
 * @property {string[]} [targetSymbols]       Symbol IDs, max 100.
 * @property {string[]} [targetFiles]         Canonical repo-relative paths, max 100.
 * @property {string} [search]
 * @property {string} [replace]
 * @property {"replace" | "insert" | "delete" | "inspect"} [operation]
 * @property {number} [maxEdits]
 */

// ============================================================================
// code.* — Code skeleton, hot-path, and raw window
// ============================================================================

/**
 * @typedef {Object} CodeGetSkeletonParams
 * @property {string} [symbolId]
 * @property {string} [file]                  Canonical repo-relative path.
 * @property {boolean} [exportedOnly]
 * @property {number} [maxLines]
 * @property {number} [maxTokens]
 * @property {string[]} [identifiersToFind]   Max 50.
 * @property {string} [ifNoneMatch]
 * @property {string} [sessionId]             Optional live-buffer overlay namespace.
 */

/**
 * @typedef {Object} CodeSurveyParams
 * @property {string | string[]} paths        One dir prefix / file path, or an array of them (max 64 files resolved).
 * @property {string} [path]                  Internal alias for a single `paths` entry (not surfaced).
 * @property {string[]} [symbols]             Optional dig terms: restrict to these symbols' neighborhoods. Max 16.
 * @property {number} [maxFiles]              Optional. Default 64.
 * @property {number} [maxSymbolsPerFile]     Internal cap override. Default 48.
 * @property {number} [maxEdges]              Internal cap override. Default 200.
 * @property {string} [sessionId]             Optional ladder-credit namespace (matches code.* actions).
 */

/**
 * @typedef {Object} CodeStructureParams
 * @property {string | string[]} paths        Directory prefix / file path, or an array of them (max 128 files resolved).
 * @property {string} [path]                  Internal alias for a single `paths` entry (not surfaced).
 * @property {("imports" | "calls" | "references" | "extends" | "implements" | "uses_type")[]} [edgeKinds] Defaults to ["imports"].
 * @property {number} [maxFiles]              Optional. Default 64, max 128.
 * @property {boolean} [includeSymbols]       Include per-file symbol summaries. Default true.
 * @property {boolean} [includeEdges]         Include exact internal/inbound/outbound edges. Default true.
 */

/**
 * @typedef {Object} CodeDbParams
 * @property {string | string[]} paths        Directory prefix / file path, or an array of them (max 128 files resolved).
 * @property {string} [path]                  Internal alias for a single `paths` entry (not surfaced).
 * @property {number} [maxFiles]              Optional. Default 64, max 128.
 */

/**
 * @typedef {Object} CodeGetHotPathParams
 * @property {string} [symbolId]
 * @property {string} [file]                  Canonical repo-relative path.
 * @property {string[]} identifiersToFind     1..50
 * @property {number} [maxLines]
 * @property {number} [maxTokens]
 * @property {number} [contextLines]
 * @property {string} [ifNoneMatch]
 * @property {string} [sessionId]             Optional live-buffer overlay namespace.
 */

/**
 * @typedef {Object} CodeNeedWindowParams
 * @property {string} [symbolId]
 * @property {string} [file]                  Canonical repo-relative path.
 * @property {string} reason                  Proof-of-need for raw-window escalation.
 * @property {number} expectedLines           Integer.
 * @property {string[]} identifiersToFind     Max 50.
 * @property {CodeGranularity} [granularity]
 * @property {number} [maxTokens]
 * @property {SliceContextHint} [sliceContext]
 * @property {string} [sessionId]             Optional live-buffer overlay namespace.
 */

/**
 * @typedef {Object} SliceContextHint
 * @property {string} taskText
 * @property {string} [stackTrace]
 * @property {string} [failingTestPath]
 * @property {string[]} [editedFiles]         Max 100.
 * @property {string[]} [entrySymbols]        Max 100.
 * @property {SliceBudget} [budget]
 */

// ============================================================================
// context — Task-shaped discovery
// ============================================================================

/**
 * @typedef {Object} ContextParams
 * @property {string} taskText
 * @property {TaskType} [taskType]
 * @property {ContextMode} [contextMode]
 * @property {string[]} [focusSymbols]
 * @property {string[]} [focusPaths]          Canonical repo-relative paths.
 * @property {number} [maxTokens]
 * @property {number} [maxActions]
 */

/**
 * Compact context projection. Shares the same retrieval inputs as
 * context, then returns a summary/evidence answer instead of the full
 * generated prompt.
 *
 * @typedef {ContextParams & {
 *   maxEvidence?: number,
 *   includeCards?: boolean,
 * }} ContextSummaryParams
 */

// ============================================================================
// agent.feedback — Useful/missing symbol reporting
// ============================================================================

/**
 * @typedef {Object} AgentFeedbackParams
 * @property {string} sliceHandle
 * @property {string[]} [usefulSymbols]
 * @property {string[]} [missingSymbols]
 * @property {TaskType} [taskType]
 * @property {string} [taskText]
 * @property {string[]} [taskTags]
 */

/**
 * @typedef {Object} AgentFeedbackQueryParams
 * @property {string} [since]                 ISO-8601 lower bound. Defaults to recent ledger policy.
 * @property {number} [limit]                 Max aggregate rows to scan.
 * @property {TaskType} [taskType]
 * @property {number} [halfLifeDays]          Optional recency decay half-life for weighted aggregates.
 */

// ============================================================================
// delta.* / review.risk.* — Review-side semantic diff and risk
// ============================================================================

/**
 * @typedef {Object} DeltaGetParams
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {number} [maxCards]
 * @property {number} [maxTokens]
 */

/**
 * @typedef {Object} PrRiskAnalyzeParams
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {number} [riskThreshold]         0..100
 */

/**
 * Combined delta + risk in one call (assessor-first entrypoint).
 *
 * @typedef {Object} PrRiskParams
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {number} [maxCards]
 * @property {number} [maxTokens]
 * @property {number} [riskThreshold]
 */

// ============================================================================
// file.read — Non-indexed file read
// ============================================================================

/**
 * @typedef {Object} FileReadParams
 * @property {string} filePath                Canonical repo-relative path.
 * @property {number} [maxBytes]
 * @property {number} [offset]                0-based line offset.
 * @property {number} [limit]                 Max lines returned.
 * @property {string} [search]                Case-insensitive regex.
 * @property {number} [searchContext]         Context lines around each match.
 * @property {string} [jsonPath]              Dot-separated extraction path for JSON/YAML.
 */

// ============================================================================
// memory.* — Native development memories
// ============================================================================

/**
 * @typedef {"ux" | "schema" | "security" | "performance"} MemoryDomain
 *   Specific filterable domains. Omitting them files the memory under the
 *   `general` catch-all (the default, not a selectable value).
 */

/**
 * @typedef {Object} MemoryStoreParams
 * @property {string} title
 * @property {string} content
 * @property {MemoryDomain[]} [domains]   Logical domain tags for filtering; default general.
 * @property {string[]} [symbolIds]
 * @property {string[]} [fileRelPaths]
 * @property {string} [memoryId]
 */

/**
 * @typedef {Object} MemoryFeedbackParams
 * @property {string} memoryId
 * @property {"used" | "stale" | "wrong" | "duplicate"} verdict
 * @property {string} [detail]                Short evidence note.
 */

/**
 * @typedef {Object} MemorySurfaceParams
 * @property {string[]} [symbolIds]
 * @property {string[]} [fileRelPaths]
 * @property {Array<"general" | MemoryDomain>} [domains]   Whitelist filter; omit for all.
 */

/**
 * @typedef {Object} MemoryGetParams
 * @property {string[]} [symbolIds]
 * @property {string[]} [fileRelPaths]
 * @property {Array<"general" | MemoryDomain>} [domains]   Whitelist filter; omit for all.
 */

// ============================================================================
// policy.* / usage.stats / scip.ingest — Native operational actions
// ============================================================================

/**
 * @typedef {Object} PolicyGetParams
 * @property {string} [repoId]
 */

/**
 * @typedef {Object} PolicySetParams
 * @property {string} [repoId]
 * @property {Object} policyPatch
 * @property {number} [policyPatch.maxWindowLines]
 * @property {number} [policyPatch.maxWindowTokens]
 * @property {boolean} [policyPatch.requireIdentifiers]
 * @property {boolean} [policyPatch.allowBreakGlass]
 * @property {number} [policyPatch.defaultMinCallConfidence]
 * @property {boolean} [policyPatch.defaultDenyRaw]
 * @property {boolean} [policyPatch.memoryEnabled]
 * @property {number} [policyPatch.memoryStaleAfterDays]
 * @property {number} [policyPatch.memoryMaxPerRepo]
 * @property {boolean} [policyPatch.runtimeEnabled]
 * @property {{ maxCards?: number, maxEstimatedTokens?: number }} [policyPatch.budgetCaps]
 */

/**
 * @typedef {Object} UsageStatsParams
 * @property {string} [repoId]
 * @property {"session" | "history" | "both"} [scope]
 * @property {string} [since]
 * @property {number} [limit]                 Max history snapshot rows returned.
 * @property {number} [aggregateLimit]        Max rows scanned for aggregate totals; default 1000.
 * @property {boolean} [persist]
 */

/**
 * @typedef {Object} RuntimeExecuteParams
 * @property {string} [repoId]
 * @property {AtlasRuntimeInput} runtime
 * @property {string} [executable]
 * @property {string[]} [args]
 * @property {string} [code]
 * @property {string} [relativeCwd]
 * @property {number} [timeoutMs]
 * @property {string[]} [queryTerms]
 * @property {number} [maxResponseLines]
 * @property {boolean} [persistOutput]
 * @property {"minimal" | "summary" | "intent"} [outputMode]
 */

/**
 * @typedef {Object} RuntimeQueryOutputParams
 * @property {string} artifactHandle
 * @property {string[]} queryTerms
 * @property {number} [maxExcerpts]
 * @property {number} [contextLines]
 * @property {"stdout" | "stderr" | "both"} [stream]
 */

/**
 * @typedef {Object} ScipIngestParams
 * @property {string} indexPath
 * @property {boolean} [dryRun]
 * @property {boolean} [force]
 * @property {string} [branch]
 */

// ============================================================================
// Discriminated union — what every dispatcher receives
// ============================================================================

/**
 * @typedef {(
 *   { action: "query" } & GatewayParams
 *   | { action: "code" } & GatewayParams
 *   | { action: "repo" } & GatewayParams
 *   | { action: "agent" } & GatewayParams
 *   | { action: "action.search" } & ActionSearchParams
 *   | { action: "manual" } & ManualParams
 *   | { action: "workflow" } & WorkflowParams
 *   | { action: "info" } & InfoParams
 *   |
 *   { action: "repo.register" } & RepoRegisterParams
 *   | { action: "repo.status" } & RepoStatusParams
 *   | { action: "index.refresh" } & IndexRefreshParams
 *   | { action: "repo.overview" } & RepoOverviewParams
 *   | { action: "repo.quality" } & RepoQualityParams
 *   | { action: "buffer.push" } & BufferPushParams
 *   | { action: "buffer.checkpoint" } & BufferCheckpointParams
 *   | { action: "buffer.status" } & BufferStatusParams
 *   | { action: "symbol.search" } & SymbolSearchParams
 *   | { action: "symbol.card" } & SymbolGetCardParams
 *   | { action: "symbol.cards" } & SymbolGetCardParams
 *   | { action: "symbol.overview" } & SymbolUsagesParams
 *   | { action: "tree.overview" } & TreeOverviewParams
 *   | { action: "tree.branch" } & TreeOverviewParams
 *   | { action: "tree.scope" } & TreeScopeParams
 *   | { action: "tree.expand" } & TreeScopeParams
 *   | { action: "slice.build" } & SliceBuildParams
 *   | { action: "slice.refresh" } & SliceRefreshParams
 *   | { action: "slice.spillover.get" } & SliceSpilloverGetParams
 *   | { action: "edit.plan" } & EditPlanParams
 *   | { action: "code.skeleton" } & CodeGetSkeletonParams
 *   | { action: "code.lens" } & CodeGetHotPathParams
 *   | { action: "code.window" } & CodeNeedWindowParams
 *   | { action: "code.survey" } & CodeSurveyParams
 *   | { action: "code.structure" } & CodeStructureParams
 *   | { action: "code.db" } & CodeDbParams
 *   | { action: "context" } & ContextParams
 *   | { action: "context.summary" } & ContextSummaryParams
 *   | { action: "agent.feedback" } & AgentFeedbackParams
 *   | { action: "agent.feedback.query" } & AgentFeedbackQueryParams
 *   | { action: "review.delta" } & DeltaGetParams
 *   | { action: "review.analyze" } & PrRiskAnalyzeParams
 *   | { action: "review.risk" } & PrRiskParams
 *   | { action: "file.read" } & FileReadParams
 *   | { action: "memory.store" } & MemoryStoreParams
 *   | { action: "memory.get" } & MemoryGetParams
 *   | { action: "memory.feedback" } & MemoryFeedbackParams
 *   | { action: "memory.surface" } & MemorySurfaceParams
 *   | { action: "policy.get" } & PolicyGetParams
 *   | { action: "policy.set" } & PolicySetParams
 *   | { action: "usage.stats" } & UsageStatsParams
 *   | { action: "runtime.execute" } & RuntimeExecuteParams
 *   | { action: "runtime.queryOutput" } & RuntimeQueryOutputParams
 *   | { action: "scip.ingest" } & ScipIngestParams
 * )} ToolCall
 */

/** Action names of every tool, in canonical dispatch order. */
export const ATLAS_TOOL_ACTIONS = Object.freeze(/** @type {const} */ ([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "workflow",
  "info",
  "repo.register",
  "repo.status",
  "index.refresh",
  "repo.overview",
  "repo.quality",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "symbol.search",
  "symbol.card",
  "symbol.cards",
  "symbol.overview",
  "tree.overview",
  "tree.branch",
  "tree.scope",
  "tree.expand",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "edit.plan",
  "code.skeleton",
  "code.lens",
  "code.window",
  "code.survey",
  "code.structure",
  "code.db",
  "context",
  "context.summary",
  "agent.feedback",
  "agent.feedback.query",
  "review.delta",
  "review.analyze",
  "review.risk",
  "file.read",
  "memory.store",
  "memory.get",
  "memory.surface",
  "memory.feedback",
  "policy.get",
  "policy.set",
  "usage.stats",
  "runtime.execute",
  "runtime.queryOutput",
  "scip.ingest",
]));

/** @typedef {(typeof ATLAS_TOOL_ACTIONS)[number]} AtlasToolAction */
