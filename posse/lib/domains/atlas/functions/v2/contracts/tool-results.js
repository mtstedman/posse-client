// @ts-check
//
// Result shape typedefs for every ATLAS v2 public tool. Structural — captures
// the contract consumers depend on (handoff rendering, embedded toolkit,
// provider integrations) without enumerating every minor field.
//
// Phase 1 implementations may add fields, but never remove or rename
// existing ones without coordinating across consumers. Bump
// `ATLAS_TOOL_RESULT_SCHEMA_VERSION` when the shape changes incompatibly.

/** @typedef {import("./tool-params.js").CardDetail} CardDetail */
/** @typedef {import("./tool-params.js").TaskType} TaskType */
/** @typedef {import("./tool-params.js").OverviewLevel} OverviewLevel */
/** @typedef {import("./tool-params.js").AtlasToolAction} AtlasToolAction */

// ============================================================================
// Common envelope and shared primitives
// ============================================================================

/**
 * Every tool result is wrapped in a result envelope so consumers have
 * uniform error handling.
 *
 * @template T
 * @typedef {Object} ToolResultEnvelope
 * @property {boolean} ok
 * @property {AtlasToolAction} action
 * @property {string} versionId               Ledger version this result was produced against.
 * @property {T} [data]                       Present when ok === true.
 * @property {ToolError} [error]              Present when ok === false.
 * @property {ToolMeta} [meta]
 */

/**
 * @typedef {Object} ToolError
 * @property {string} code                    Stable identifier, e.g. "not_indexed", "unresolved_symbol", "budget_exceeded".
 * @property {string} message
 * @property {Record<string, unknown>} [details]
 */

/**
 * @typedef {Object} ToolMeta
 * @property {number} [durationMs]
 * @property {boolean} [cached]
 * @property {string} [etag]
 * @property {boolean} [notModified]          True when ifNoneMatch matched — `data` may be omitted.
 * @property {BackendHealthReport} [backendHealth]   Per-backend status for tools that fan out across retrieval backends (e.g. symbol.search). Optional; absent when the tool didn't run a multi-backend stage.
 * @property {SemanticSearchMeta} [semantic]  Present when semantic search was requested; says whether vector ranking actually contributed.
 * @property {QueryPlanMeta} [queryPlan]      Present for symbol.search; compact view of the parsed query facets used by retrieval.
 * @property {Record<string, unknown>} [operation]    Operation progress snapshot for long-running or failure-prone tools.
 * @property {Record<string, unknown>} [diagnostics]  Diagnostic timings/events when requested by the caller.
 * @property {string[]} [warnings]           High-level degradation warnings consumers should surface without walking the payload.
 */

/**
 * Snapshot of retrieval-backend health for one tool call. Populated by
 * the hybrid orchestrator when symbol.search runs FTS / vector / etc.
 * in parallel. `active` is the list of backends that contributed entries
 * to the fused ranking; `unavailable` is the list that was skipped or
 * failed (with a reason in `backends[name].reason`).
 *
 * @typedef {Object} BackendHealthReport
 * @property {Record<string, BackendHealthEntry>} backends
 * @property {string[]} active
 * @property {string[]} unavailable
 * @property {boolean} fullyDegraded          True iff no backend ran successfully.
 */

/**
 * @typedef {Object} BackendHealthEntry
 * @property {boolean} ok
 * @property {string} [reason]                Stable identifier when ok=false ("unavailable" | "dim_mismatch" | "encode_error" | "query_error" | "unknown").
 */

/**
 * @typedef {Object} SemanticSearchMeta
 * @property {boolean} requested
 * @property {boolean} available
 * @property {string | null} provider
 * @property {string | null} degradedReason
 */

/**
 * Query facets extracted before retrieval fan-out. This is intentionally
 * compact and JSON-safe so observations / benchmarks can inspect why a
 * natural-language search hit a symbol without depending on internals.
 *
 * @typedef {Object} QueryPlanMeta
 * @property {string[]} identifiers
 * @property {string[]} paths
 * @property {string[]} fileNames
 * @property {string[]} languageHints
 * @property {string | null} symptom
 * @property {string[]} keywords
 * @property {boolean} identifierLike
 * @property {{ fn: string, file?: string, line?: number }[]} stackFrames
 */

/**
 * @typedef {Object} SymbolLocation
 * @property {string} repo_rel_path
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} [startByte]
 * @property {number} [endByte]
 */

/**
 * Stable symbol reference. In v2 this is a string of the form
 * `"<content_hash>:<local_id>"`, but consumers should treat it as opaque.
 *
 * @typedef {string} SymbolId
 */

// ============================================================================
// SymbolCard — the canonical "what is this symbol" shape, returned by
// symbol.card, embedded in slice.build, review.delta, review.risk results.
// ============================================================================

/**
 * @typedef {Object} SymbolCard
 * @property {SymbolId} symbolId
 * @property {string} name
 * @property {string | null} qualifiedName
 * @property {string} kind
 * @property {string} lang
 * @property {SymbolLocation} location
 * @property {string | null} signature        Detail level-dependent.
 * @property {string | null} summary
 * @property {string} [visibility]
 * @property {Record<string, string[]>} [deps]
 * @property {SymbolCardMetrics} [metrics]
 * @property {CardDetail} [detailLevel]
 * @property {SymbolHit[]} [callers]
 * @property {SymbolHit[]} [callees]
 * @property {string} [etag]
 * @property {ResolutionMetadata} [resolution]   Populated when includeResolutionMetadata=true.
 */

/**
 * @typedef {Object} SymbolCardMetrics
 * @property {number} fanIn
 * @property {number} fanOut
 * @property {number} callFanIn
 * @property {number} callFanOut
 * @property {number} importCount
 * @property {number} unresolvedFanOut
 */

/**
 * @typedef {Object} SymbolHit
 * @property {SymbolId} symbolId
 * @property {string} name
 * @property {string} [qualifiedName]
 * @property {string} kind
 * @property {string} lang
 * @property {SymbolLocation} location
 * @property {number} [score]                 Raw retrieval score. For symbol.search durable hits this is raw RRF unless meta.scoreScheme says otherwise.
 * @property {"exact" | "strong" | "weak"} [relevance]
 * @property {number} [confidence]            Resolver confidence, 0..1.
 * @property {boolean} [overlay]              True when the hit came from a live buffer overlay.
 * @property {string} [source]                Retrieval source hint, e.g. "buffer".
 * @property {{ filePath: string, sessionId: string, version: number | null }} [buffer]
 */

/**
 * @typedef {Object} EntitySearchHit
 * @property {"feedback"} entity
 * @property {string} id
 * @property {string} title
 * @property {string} [snippet]
 * @property {number} score
 * @property {Record<string, unknown>} [ref]
 */

/**
 * @typedef {Object} ResolutionMetadata
 * @property {number} confidence
 * @property {string} method                  "ast-direct" | "pass2-name" | "pass2-typed" | ...
 * @property {string[]} [ambiguousAlternatives]
 */

// ============================================================================
// repo.* result shapes
// ============================================================================

/**
 * @typedef {Object} RepoRegisterData
 * @property {string} repoId
 * @property {string} repoRoot
 * @property {string} ledgerPath
 * @property {string} viewPath
 * @property {string} versionId
 * @property {boolean} createdLedger
 * @property {boolean} createdView
 * @property {boolean} alreadyRegistered
 */

/**
 * @typedef {Object} RepoStatusData
 * @property {string} repoId
 * @property {string} versionId               Latest ledger version (ETag-shaped).
 * @property {number} indexedSymbols
 * @property {number} indexedFiles
 * @property {string[]} languages
 * @property {string} lastIndexedAt           ISO-8601.
 * @property {string} [repoRoot]
 * @property {string} [ledgerPath]
 * @property {string} [viewPath]
 * @property {string} [branch]
 * @property {number} [ledgerSeq]
 * @property {{ enabled: boolean, provider: string | null, backend?: string | null, indexedCount?: number, reason?: string | null }} [embeddings]
 * @property {{ warnings: string[] }} [diagnostics]
 * @property {MemorySurfaceData} [surfacedMemories]
 * @property {{ healthScore: number, components: Record<string, number>, current: boolean, reason: string | null }} [health]
 * @property {{ byLang: Record<string, number>, byKind: Record<string, number>, tokenMetrics: Record<string, number> }} [index]
 * @property {{ total: number, resolved: number, unresolved: number, unresolvedRate: number, internal?: number, external?: number, runtimeExternal?: number, importScopedExternal?: number, dynamicReceiver?: number, localUnbound?: number, selfReceiver?: number, trueUnresolved?: number, callTotal?: number, callResolved?: number, callResolutionRate?: number, taxonomy?: Record<string, number> | null, taxonomyUnavailable?: string }} [edges]
 * @property {Record<string, unknown>} [capabilities]
 * @property {Record<string, unknown>} [watcherHealth]
 * @property {Record<string, unknown>} [liveIndexStatus]
 * @property {Record<string, unknown>} [prefetchStats]
 * @property {Record<string, unknown>} [cacheStats]
 * @property {Record<string, unknown>} [semanticStatus]
 * @property {Record<string, unknown>} [indexProgress]
 * @property {Record<string, unknown>} [graphDerivedState]
 * @property {{ memories: number, feedbackSignals: number } | null} [memoryStats]
 * @property {{ available: boolean, profile?: string | null, builtAt?: string | null, seedCount?: number, currentLabels?: number, staleLabels?: number, maxDriftCount?: number, oldestStaleSince?: string | null, lastLabeledAt?: string | null } | null} [treeCompression]
 * @property {Record<string, unknown>} [dataQuality]
 * @property {{ memory: boolean, runtime: boolean, workflow: boolean, liveBuffers: boolean, scipIngest: boolean }} [features]
 */

/**
 * @typedef {Object} IndexRefreshData
 * @property {string} repoRoot
 * @property {string} branch
 * @property {"full" | "incremental"} mode
 * @property {string} versionId
 * @property {string | null} viewPath
 * @property {unknown} warmResult
 * @property {Record<string, unknown>} [operation]
 * @property {Record<string, unknown>} [diagnostics]
 */

/**
 * @typedef {Object} RepoQualityData
 * @property {string | undefined} repoRoot
 * @property {string | undefined} viewPath
 * @property {{ branch: string, ledgerSeq: number, headSeq: number | null, current: boolean, reason: string | null }} view
 * @property {{ files: number, symbols: number, languages: string[] }} coverage
 * @property {{ total: number, resolved: number, unresolved: number, unresolvedRate: number }} edges
 * @property {{ knownLanguageCount: number, observedLanguages: string[], observedFailures: { lang: string, error: string }[], probed: boolean, probedLanguages: { lang: string, ok: boolean, error?: string }[] }} treeSitter
 * @property {{ enabled: boolean, provider: string | null, backend?: string | null, indexedCount?: number, reason?: string | null } | undefined} embeddings
 * @property {{ totalFeedback: number, usefulFeedback?: number, missingFeedback?: number, topMissingSymbols: { symbolId: SymbolId, count: number }[] } | undefined} feedback
 * @property {Record<string, unknown>} [dataQuality]
 * @property {{ warnings: string[] }} diagnostics
 */

/**
 * @typedef {Object} RepoOverviewData
 * @property {OverviewLevel} level
 * @property {RepoOverviewStats} [stats]
 * @property {RepoDirectorySummary[]} [directories]
 * @property {RepoHotspot[]} [hotspots]
 * @property {Record<string, unknown>} [graph]
 * @property {Record<string, unknown>} [capabilities]
 * @property {string} [etag]
 */

/**
 * @typedef {Object} RepoOverviewStats
 * @property {number} files
 * @property {number} symbols
 * @property {Record<string, number>} byLang
 * @property {Record<string, number>} [byKind]
 * @property {Record<string, unknown>} [edges]
 * @property {Record<string, number>} [tokenMetrics]
 */

/**
 * @typedef {Object} RepoDirectorySummary
 * @property {string} repo_rel_path
 * @property {number} files
 * @property {number} symbols
 * @property {SymbolHit[]} [topExports]
 * @property {SymbolHit[]} [topByFanIn]
 * @property {SymbolHit[]} [topByFanOut]
 */

/**
 * @typedef {Object} RepoHotspot
 * @property {string} repo_rel_path
 * @property {number} inboundEdges
 * @property {number} outboundEdges
 * @property {number} [symbolCount]
 * @property {number} [score]
 * @property {string} reason
 */

// ============================================================================
// buffer.* result shapes
// ============================================================================

/**
 * @typedef {Object} BufferPushData
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} contentHash
 * @property {number} byteLength
 * @property {number | null} version
 * @property {boolean} parsed
 * @property {number} symbolCount
 * @property {boolean} [persisted]
 * @property {string} [eventType]
 * @property {string | null} [language]
 * @property {boolean} [dirty]
 * @property {Record<string, number> | null} [cursor]
 * @property {Array<Record<string, number>>} [selections]
 * @property {string} [updatedAt]
 * @property {string[]} [warnings]
 * @property {boolean} [replaced]
 */

/**
 * @typedef {Object} BufferCheckpointData
 * @property {string} filePath
 * @property {string} sessionId
 * @property {boolean} cleared
 * @property {boolean} wroteToDisk
 * @property {boolean} diskMatches
 * @property {string | null} contentHash
 */

/**
 * @typedef {Object} BufferStatusData
 * @property {BufferStatusEntry[]} buffers
 * @property {number} total
 * @property {number} [totalBytes]
 * @property {number} [dirtyCount]
 * @property {number} [parsedCount]
 * @property {number} [parseFailureCount]
 * @property {number} [syntaxErrorCount]
 * @property {number} [parseExceptionCount]
 * @property {number} [pendingParseCount]
 * @property {number} [draftLimit]
 * @property {boolean} [draftLimitReached]
 * @property {number} [staleRejectedCount]
 * @property {number} [versionConflictRejectedCount]
 * @property {number} [draftLimitRejectedCount]
 * @property {string | null} [lastUpdatedAt]
 * @property {string | null} [lastRejectedAt]
 * @property {string[]} [warnings]
 */

/**
 * @typedef {Object} BufferStatusEntry
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} contentHash
 * @property {number} byteLength
 * @property {number | null} version
 * @property {boolean} diskMatches
 * @property {boolean} [persisted]
 * @property {string} updatedAt
 * @property {boolean} [parsed]
 * @property {number} [symbolCount]
 * @property {string} [eventType]
 * @property {string | null} [language]
 * @property {boolean} [dirty]
 * @property {Record<string, number> | null} [cursor]
 * @property {Array<Record<string, number>>} [selections]
 * @property {string[]} [warnings]
 */

// ============================================================================
// symbol.* result shapes
// ============================================================================

/**
 * @typedef {Object} SymbolSearchData
 * @property {SymbolHit[]} items
 * @property {EntitySearchHit[]} [entities]   Optional opt-in entity hits.
 * @property {number} total
 * @property {boolean} truncated
 */

/**
 * symbol.card returns a single SymbolCard. The envelope's `data` is
 * the card directly, unless called with batch fields (`symbolIds` /
 * `symbolRefs`), where it returns the same shape as symbol.cards.
 *
 * @typedef {SymbolCard} SymbolGetCardData
 */

/**
 * @typedef {Object} SymbolCardError
 * @property {number} index
 * @property {string} code
 * @property {string} message
 * @property {string} [symbolId]
 * @property {Record<string, unknown>} [symbolRef]
 */

/**
 * @typedef {Object} SymbolCardsData
 * @property {SymbolCard[]} cards
 * @property {SymbolCardError[]} errors
 * @property {number} total
 * @property {number} okCount
 * @property {number} errorCount
 * @property {boolean} partial
 */

/**
 * @typedef {Object} SymbolUsageSite
 * @property {string} repo_rel_path
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} startByte
 * @property {number} endByte
 * @property {SymbolId} fromSymbolId
 * @property {string} fromName
 * @property {string | null} [fromQualifiedName]
 * @property {SymbolHit} [fromSymbol]
 * @property {string} kind
 * @property {number} confidence
 * @property {boolean} resolved
 */

/**
 * @typedef {Object} SymbolUsagesData
 * @property {SymbolId} symbolId
 * @property {string} name
 * @property {string | null} [qualifiedName]
 * @property {SymbolUsageSite[]} usages
 * @property {number} total
 * @property {boolean} truncated
 */

// ============================================================================
// tree.* result shapes
// ============================================================================

/**
 * @typedef {Object} TreeNodeSummary
 * @property {string} nodeId
 * @property {string | null} parentNodeId
 * @property {"root" | "dir" | "file" | string} kind
 * @property {string} label
 * @property {string} stableRef
 * @property {string | null} repoRelPath
 * @property {SymbolId | null} symbolRef
 * @property {number | null} symbolGlobalId  View-local FK convenience only; use nodeId/symbolRef for identity.
 * @property {number} depth
 * @property {number} relativeDepth
 * @property {number} sortOrder
 * @property {number} childCount
 * @property {number} descendantSymbolCount
 * @property {number} descendantFileCount
 * @property {Record<string, unknown>} [aggregates]
 * @property {string[]} [terms]
 * @property {Array<{ refType: "cluster" | "process" | string, refId: string, weight: number }>} [refs]
 * @property {string} [areaLabel]  Compressed-tree label for this area, when a compression seed annotates the node's path.
 */

/**
 * @typedef {Object} TreeOverviewData
 * @property {boolean} available
 * @property {string} [reason]
 * @property {string[]} [missingTables]
 * @property {Record<string, unknown>} focus
 * @property {TreeNodeSummary | null} root
 * @property {TreeNodeSummary[]} matches
 * @property {number} matchTotal              Total focus matches before the capped matches array is returned.
 * @property {boolean} focusTruncated         True when focus lookup matched more nodes than the capped matches array.
 * @property {TreeNodeSummary[]} nodes
 * @property {Array<{ path: string, label: string, confidence: number, confidenceBand: "high" | "medium" | "low" }>} [areaMap]  Top-level calls only: compressed-tree labeled area map.
 * @property {number} total
 * @property {number} [offset]
 * @property {number} [limit]
 * @property {number} [maxDepth]
 * @property {boolean} truncated
 * @property {number | null} [nextOffset]
 * @property {{ builtAt: string, status: string, durationMs: number, details: Record<string, unknown> } | null} latestRun
 * @property {string[]} [warnings]
 */

/**
 * @typedef {Object} TreeScopeFile
 * @property {string} path
 * @property {string} nodeId
 * @property {number} score
 * @property {string[]} reasons
 * @property {boolean} exactSeed
 * @property {number} symbolCount
 * @property {boolean} generated
 * @property {boolean} test
 * @property {boolean} config
 */

/**
 * @typedef {Object} TreeScopeDir
 * @property {string} path
 * @property {string} nodeId
 * @property {number} score
 * @property {string[]} reasons
 * @property {number} fileCount
 * @property {number} symbolCount
 */

/**
 * @typedef {Object} TreeScopeRefinementCandidate
 * @property {string} path
 * @property {string} nodeId
 * @property {string} kind
 * @property {number} score
 * @property {string} sourcePath
 * @property {string} reason
 * @property {number} fileCount
 * @property {number} symbolCount
 * @property {number} childCount
 * @property {boolean} acceptsBranchFileCap
 * @property {boolean} generated
 * @property {boolean} test
 * @property {boolean} config
 */

/**
 * @typedef {Object} TreeScopeMetrics
 * @property {number} candidateFileCount
 * @property {number} estimatedTouchedFiles
 * @property {number} candidateDirCount
 * @property {number} areasTouched
 * @property {number} largestAreaFileCount
 * @property {number} generatedFileCount
 * @property {number} testFileCount
 * @property {number} configFileCount
 * @property {number} sourceFileCount
 * @property {number} symbolCount
 * @property {number} compression
 * @property {number} [queryTermCoverage]
 * @property {number} confidence
 * @property {"none" | "single_file" | "small_cluster" | "multi_area" | "broad"} scopeBand
 * @property {"low" | "medium" | "high"} scopeRisk
 * @property {boolean} testsLikelyNeeded
 * @property {boolean} generatedOrConfigTouched
 * @property {number} [exactSeedCount]
 * @property {number} [queryTermCount]
 * @property {number} [broadRefCount]
 * @property {number} [broadDirCount]
 */

/**
 * @typedef {Object} TreeScopeSidecar
 * @property {boolean} used
 * @property {string} [source]
 * @property {string} [reason]
 * @property {number} [files]
 * @property {number} [dirs]
 * @property {number} [terms]
 */

/**
 * @typedef {Object} TreeScopeData
 * @property {boolean} available
 * @property {string} [reason]
 * @property {string[]} [missingTables]
 * @property {string[]} queryTerms
 * @property {Record<string, unknown>} seeds
 * @property {TreeScopeFile[]} candidateFiles
 * @property {TreeScopeDir[]} candidateDirs
 * @property {TreeScopeRefinementCandidate[]} [refinementCandidates]
 * @property {Array<Record<string, unknown>>} rejectedBroadDirs
 * @property {Array<Record<string, unknown>>} rejectedBroadRefs
 * @property {TreeScopeMetrics} metrics
 * @property {TreeScopeCompression} [compression]
 * @property {TreeScopeSidecar} [sidecar]
 * @property {{ builtAt: string, status: string, durationMs: number, details: Record<string, unknown> } | null} [latestRun]
 * @property {string[]} [warnings]
 */

/**
 * Compressed-tree (tree-compression seed) involvement in this scope pass.
 * Seeds are advisory vocabulary bridges; matchedSeeds lists the repo areas
 * whose label/alias vocabulary matched the task text and boosted candidates.
 *
 * @typedef {Object} TreeScopeCompression
 * @property {boolean} available
 * @property {string | null} [reason]
 * @property {string | null} [profile]
 * @property {Array<{ path: string, label: string, confidence: number, confidenceBand: "high" | "medium" | "low", hits: number, entrypoints: string[] }>} matchedSeeds
 * @property {Array<{ path: string, label: string, confidence: number, confidenceBand: "high" | "medium" | "low" }>} [areaMap]
 *   Labeled repo orientation: most-specific annotated areas with ancestor
 *   chains collapsed. Drill into any area via tree.overview {path, maxDepth}.
 */

// ============================================================================
// slice.* result shapes — the central retrieval envelope
// ============================================================================

/**
 * @typedef {Object} SliceData
 * @property {string} sliceHandle             Opaque; pass to slice.refresh.
 * @property {string} knownVersion            Pair with sliceHandle for refresh.
 * @property {SymbolCard[]} cards
 * @property {SliceCardRef[]} [cardRefs]       Cards omitted because knownCardEtags matched.
 * @property {SliceBudgetUsage} budgetUsage
 * @property {boolean} truncated
 * @property {string} [spilloverHandle]       Present when truncated; pass to slice.spillover.get.
 * @property {number} totalCardCount          Including spillover.
 * @property {SliceWireFormat} wireFormat
 * @property {PackedSliceData} [packed]       Present when wireFormat.kind === "packed".
 * @property {SliceFrontierItem[]} [frontier] Top expansion candidates not returned in `cards`.
 * @property {MemorySurfaceData} [memorySurface] Non-critical anchor-presence probe when native memory is available.
 */

/**
 * @typedef {Object} SliceCardRef
 * @property {SymbolId} symbolId
 * @property {string} etag
 * @property {string} [detailLevel]
 */

/**
 * @typedef {Object} SliceFrontierItem
 * @property {SymbolId} symbolId
 * @property {string} why
 */

/**
 * @typedef {Object} SliceBudgetUsage
 * @property {number} cardsReturned
 * @property {number} [cardRefsReturned]
 * @property {number} [packedRows]
 * @property {number} estimatedTokens
 * @property {number} [frontierTokensEstimate]
 * @property {boolean} hitCardCap
 * @property {boolean} hitTokenCap
 */

/**
 * @typedef {Object} SliceWireFormat
 * @property {"standard" | "compact" | "agent" | "packed"} kind
 * @property {1 | 2 | 3} version
 */

/**
 * @typedef {Object} PackedSliceData
 * @property {number} schemaVersion
 * @property {string[]} columns
 * @property {Array<Array<string | number | null>>} rows
 * @property {number} cardCount
 */

/**
 * @typedef {Object} SliceRefreshData
 * @property {string} sliceHandle
 * @property {string} knownVersion
 * @property {SymbolCard[]} addedCards
 * @property {SymbolId[]} removedSymbolIds
 * @property {SymbolCard[]} changedCards
 * @property {boolean} stillValid             False means the caller should re-build via slice.build.
 */

/**
 * @typedef {Object} SliceSpilloverGetData
 * @property {SymbolCard[]} cards
 * @property {string} [nextCursor]
 * @property {boolean} hasMore
 */

/**
 * @typedef {Object} EditPlanData
 * @property {string} planId
 * @property {boolean} previewOnly
 * @property {EditPlanEdit[]} edits
 * @property {{ files: number, symbols: number }} coverage
 * @property {string[]} warnings
 * @property {string[]} nextActions
 */

/**
 * @typedef {Object} EditPlanEdit
 * @property {string} editId
 * @property {string} operation
 * @property {string} repo_rel_path
 * @property {SymbolId | null} symbolId
 * @property {string | null} symbolName
 * @property {string | null} search
 * @property {string | null} replace
 * @property {Record<string, unknown>} precondition
 * @property {number} confidence
 * @property {string} rationale
 */

// ============================================================================
// code.* result shapes
// ============================================================================

/**
 * @typedef {Object} CodeSkeletonData
 * @property {SymbolId} [symbolId]
 * @property {string} repo_rel_path
 * @property {string} content                 The deterministic skeleton text.
 * @property {number} startLine
 * @property {number} endLine
 * @property {boolean} truncated
 * @property {string} [etag]
 */

/**
 * @typedef {Object} CodeHotPathData
 * @property {SymbolId} [symbolId]
 * @property {string} [repo_rel_path]
 * @property {CodeHotPathMatch[]} matches
 * @property {string[]} identifiersFound
 * @property {string[]} [identifiersFoundInText]  Identifiers with no AST usage but present inside string/comment text (matchKind "text").
 * @property {string[]} identifiersMissing
 * @property {string} [etag]
 */

/**
 * @typedef {Object} CodeHotPathMatch
 * @property {string} repo_rel_path
 * @property {number} line
 * @property {string} text
 * @property {string} identifier
 * @property {"text"} [matchKind]  Absent for AST usage matches; "text" when the identifier was only found inside string/comment text.
 * @property {{ before: string[], after: string[] }} context
 */

/**
 * @typedef {Object} CodeWindowData
 * @property {SymbolId} [symbolId]
 * @property {string} repo_rel_path
 * @property {string} content
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} estimatedTokens
 * @property {boolean} truncated
 */

// ============================================================================
// context result shape
// ============================================================================

/**
 * @typedef {Object} ContextData
 * @property {TaskType | undefined} taskType
 * @property {SymbolHit[]} retrievedSymbols
 * @property {SymbolCard[]} cards
 * @property {string} generatedContext        Provider-ready prompt fragment.
 * @property {number} estimatedTokens
 * @property {number} actionsConsumed
 * @property {SurfacedMemory[]} [memories]
 * @property {boolean} [truncated]
 * @property {ContextBudgetUsage} [budgetUsage]
 */

/**
 * @typedef {Object} ContextBudgetUsage
 * @property {number} maxTokens
 * @property {number} cardsReturned
 * @property {number} cardsAvailable
 * @property {number} memoriesReturned
 * @property {number} memoriesAvailable
 */

/**
 * @typedef {Object} ContextSummaryData
 * @property {string} taskId
 * @property {TaskType | undefined} taskType
 * @property {boolean} success
 * @property {string} summary
 * @property {string} answer
 * @property {Array<Record<string, unknown>>} finalEvidence
 * @property {number} estimatedTokens
 * @property {number} actionsConsumed
 * @property {{ confidence: "high" | "medium" | "low", evidenceItems: number, selectedContextItems: number, limitations: string[], guidance: string[] }} contextQuality
 * @property {{ sources: string[], symbolCount: number, memoryCount: number, mode: string }} retrievalEvidence
 * @property {string} nextBestAction
 * @property {SymbolCard[]} [cards]
 */

// ============================================================================
// agent.feedback result shape
// ============================================================================

/**
 * @typedef {Object} AgentFeedbackData
 * @property {boolean} recorded        True only when at least one signal row actually landed.
 * @property {number} usefulCount      Requested useful ids (before validation).
 * @property {number} missingCount     Requested missing ids (before validation).
 * @property {number} insertedCount    Rows the store actually inserted (malformed ids are skipped).
 * @property {number} [skippedCount]   Requested minus inserted, when any id was skipped.
 * @property {string} [errorMessage]
 */

/**
 * @typedef {Object} AgentFeedbackQueryData
 * @property {AgentFeedbackAggregate[]} feedback
 * @property {AgentFeedbackStats} aggregatedStats
 * @property {boolean} hasMore
 */

/**
 * @typedef {Object} AgentFeedbackAggregate
 * @property {SymbolId} symbolId
 * @property {number} usefulCount
 * @property {number} missingCount
 * @property {number} [usefulWeight]
 * @property {number} [missingWeight]
 * @property {string} lastTs
 */

/**
 * @typedef {Object} AgentFeedbackStats
 * @property {number} totalFeedback
 * @property {number} [usefulFeedback]
 * @property {number} [missingFeedback]
 * @property {{ symbolId: SymbolId, count: number }[]} topUsefulSymbols
 * @property {{ symbolId: SymbolId, count: number }[]} topMissingSymbols
 */

// ============================================================================
// delta.* / review.risk.* result shapes
// ============================================================================

/**
 * @typedef {Object} DeltaData
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {DeltaCard[]} cards
 * @property {DeltaSummary} summary
 * @property {SliceBudgetUsage} budgetUsage
 * @property {boolean} truncated
 * @property {string} [spilloverHandle]
 */

/**
 * @typedef {Object} DeltaCard
 * @property {SymbolId} symbolId
 * @property {"added" | "removed" | "modified" | "moved"} change
 * @property {SymbolCard} [before]            Present for removed/modified.
 * @property {SymbolCard} [after]             Present for added/modified.
 * @property {SymbolLocation} [movedFrom]     Present when change === "moved".
 */

/**
 * @typedef {Object} DeltaSummary
 * @property {number} added
 * @property {number} removed
 * @property {number} modified
 * @property {number} moved
 * @property {string[]} touchedPaths
 */

/**
 * @typedef {Object} PrRiskAnalyzeData
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {RiskFinding[]} findings
 * @property {SymbolHit[]} blastRadius        Symbols transitively impacted.
 * @property {TestRecommendation[]} recommendedTests
 * @property {number} riskScore               0..100.
 */

/**
 * @typedef {Object} RiskFinding
 * @property {string} id
 * @property {"info" | "low" | "medium" | "high" | "critical"} severity
 * @property {string} category                Stable identifier, e.g. "api_break", "unbounded_recursion", "test_gap".
 * @property {string} message
 * @property {SymbolId[]} [relatedSymbols]
 * @property {SymbolLocation[]} [locations]
 */

/**
 * @typedef {Object} TestRecommendation
 * @property {SymbolId} symbolId
 * @property {string} reason
 * @property {"high" | "medium" | "low"} priority
 */

/**
 * Combined delta + risk envelope returned by review.risk.
 *
 * @typedef {Object} PrRiskData
 * @property {DeltaData} delta
 * @property {PrRiskAnalyzeData} risk
 */

// ============================================================================
// file.read result shape
// ============================================================================

/**
 * @typedef {Object} FileReadData
 * @property {string} repo_rel_path
 * @property {string} content
 * @property {number} totalBytes
 * @property {number} totalLines
 * @property {number} returnedLines
 * @property {number} startLine
 * @property {boolean} truncated
 * @property {boolean} [searchTimedOut]          Present when search stopped after the scan time budget.
 * @property {FileReadSearchMatch[]} [matches]   Present when `search` was set.
 * @property {unknown} [jsonPathValue]            Present when `jsonPath` was set and matched.
 */

/**
 * @typedef {Object} FileReadSearchMatch
 * @property {number} line
 * @property {string} text
 * @property {{ before: string[], after: string[] }} context
 */

// ============================================================================
// memory.* / policy.* / usage.stats / scip.ingest result shapes
// ============================================================================

/**
 * @typedef {Object} MemoryStoreData
 * @property {boolean} ok
 * @property {string} memoryId
 * @property {string} [memory_id]
 * @property {boolean} created
 * @property {boolean} deduplicated
 * @property {boolean} [nearDuplicate]
 * @property {string} [mergedDuplicateMemoryId]
 */

/**
 * @typedef {Object} MemorySurfaceData
 * @property {SymbolId[]} symbols
 * @property {string[]} files
 */

/**
 * @typedef {Object} MemoryGetRow
 * @property {string} memoryId
 * @property {string} [memory_id]
 * @property {string} title
 * @property {string} content
 * @property {string} source
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {SymbolId[]} symbolIds
 * @property {string[]} fileRelPaths
 */

/**
 * @typedef {Object} MemoryGetData
 * @property {Record<string, MemoryGetRow[]>} symbols
 * @property {Record<string, MemoryGetRow[]>} files
 */

/**
 * @typedef {Object} MemoryFeedbackData
 * @property {boolean} ok
 * @property {string} memoryId
 * @property {string} [memory_id]
 * @property {"used" | "stale" | "wrong" | "duplicate"} verdict
 * @property {string} [detail]
 * @property {boolean} [stale]
 * @property {string} [staleReason]
 * @property {boolean} [recorded]
 * @property {number} [wrongCount]
 */

/**
 * @typedef {Object} PolicyData
 * @property {string} repoId
 * @property {Record<string, unknown>} policy
 * @property {boolean} [ok]
 */

/**
 * @typedef {Object} UsageStatsData
 * @property {Record<string, unknown>} [session]
 * @property {Record<string, unknown>} [history]
 * @property {string} [formattedSummary]
 */

/**
 * @typedef {Object} RuntimeExcerpt
 * @property {number} lineStart
 * @property {number} lineEnd
 * @property {string} content
 * @property {"stdout" | "stderr"} source
 */

/**
 * @typedef {Object} RuntimeExecuteData
 * @property {"success" | "failure" | "timeout" | "denied"} status
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {number} durationMs
 * @property {string} stdoutSummary
 * @property {string} [stdoutPreview]
 * @property {string} stderrSummary
 * @property {string | null} artifactHandle
 * @property {RuntimeExcerpt[]} [excerpts]
 * @property {{ stdoutTruncated: boolean, stderrTruncated: boolean, totalStdoutBytes: number, totalStderrBytes: number }} truncation
 * @property {{ auditHash: string, deniedReasons?: string[] }} [policyDecision]
 * @property {Record<string, unknown>} [command]
 */

/**
 * @typedef {Object} RuntimeQueryOutputData
 * @property {string} artifactHandle
 * @property {RuntimeExcerpt[]} excerpts
 * @property {number} totalLines
 * @property {number} totalBytes
 * @property {Array<"stdout" | "stderr">} searchedStreams
 */

/**
 * @typedef {Object} ScipIngestData
 * @property {boolean} [dryRun]
 * @property {string} indexPath
 * @property {string} [branch]
 * @property {string} [versionId]
 * @property {string | null} [viewPath]
 */

// ============================================================================
// gateway wrapper result shape
// ============================================================================

/** @typedef {Record<string, unknown>} GatewayData */

// ============================================================================
// action.search / manual result shapes
// ============================================================================

/**
 * @typedef {Object} ActionSearchData
 * @property {string} query
 * @property {string | null} namespace
 * @property {number} total
 * @property {Array<Record<string, unknown>>} actions
 */

/**
 * @typedef {Object} ManualData
 * @property {string} query
 * @property {Array<Record<string, unknown>>} actions
 * @property {string} manual
 * @property {number} tokenEstimate
 */

// ============================================================================
// workflow result shape
// ============================================================================

/**
 * @typedef {Object} WorkflowStepData
 * @property {number} stepIndex
 * @property {string} [id]
 * @property {string} fn
 * @property {string} [action]
 * @property {"ok" | "error" | "skipped" | "budget_exceeded"} status
 * @property {unknown} result
 * @property {number} tokens
 * @property {number} durationMs
 * @property {string} [error]
 * @property {{ originalTokens: number, keptTokens: number }} [truncatedResponse]
 */

/**
 * @typedef {Object} WorkflowData
 * @property {WorkflowStepData[]} results
 * @property {number} totalTokens
 * @property {number} durationMs
 * @property {boolean} truncated
 * @property {Record<string, unknown>} [dryRun]
 * @property {Record<string, unknown>} [trace]
 */

// ============================================================================
// info result shape
// ============================================================================

/**
 * @typedef {Object} InfoData
 * @property {string} version
 * @property {Record<string, unknown>} runtime
 * @property {Record<string, unknown>} repo
 * @property {Record<string, unknown>} storage
 * @property {Record<string, unknown>} view
 * @property {Record<string, unknown>} ledger
 * @property {Record<string, unknown>} [policy]
 * @property {string[]} warnings
 */

// ============================================================================
// Discriminated result envelope — one shape per action. Use this instead
// of a key-map typedef; JSDoc's @property syntax doesn't accept dotted
// keys, and a discriminated union is what consumers actually narrow on.
// ============================================================================

/**
 * @typedef {(
 *   ToolResultEnvelope<GatewayData>           & { action: "query" }
 *   | ToolResultEnvelope<GatewayData>         & { action: "code" }
 *   | ToolResultEnvelope<GatewayData>         & { action: "repo" }
 *   | ToolResultEnvelope<GatewayData>         & { action: "agent" }
 *   | ToolResultEnvelope<ActionSearchData>    & { action: "action.search" }
 *   | ToolResultEnvelope<ManualData>          & { action: "manual" }
 *   | ToolResultEnvelope<WorkflowData>        & { action: "workflow" }
 *   | ToolResultEnvelope<InfoData>            & { action: "info" }
 *   | ToolResultEnvelope<RepoRegisterData>      & { action: "repo.register" }
 *   | ToolResultEnvelope<RepoStatusData>      & { action: "repo.status" }
 *   | ToolResultEnvelope<IndexRefreshData>    & { action: "index.refresh" }
 *   | ToolResultEnvelope<RepoOverviewData>     & { action: "repo.overview" }
 *   | ToolResultEnvelope<RepoQualityData>      & { action: "repo.quality" }
 *   | ToolResultEnvelope<BufferPushData>       & { action: "buffer.push" }
 *   | ToolResultEnvelope<BufferCheckpointData> & { action: "buffer.checkpoint" }
 *   | ToolResultEnvelope<BufferStatusData>     & { action: "buffer.status" }
 *   | ToolResultEnvelope<SymbolSearchData>     & { action: "symbol.search" }
 *   | ToolResultEnvelope<SymbolGetCardData | SymbolCardsData> & { action: "symbol.card" }
 *   | ToolResultEnvelope<SymbolCardsData>      & { action: "symbol.cards" }
 *   | ToolResultEnvelope<SymbolUsagesData>     & { action: "symbol.overview" }
 *   | ToolResultEnvelope<TreeOverviewData>      & { action: "tree.overview" }
 *   | ToolResultEnvelope<TreeOverviewData>      & { action: "tree.branch" }
 *   | ToolResultEnvelope<TreeScopeData>         & { action: "tree.scope" }
 *   | ToolResultEnvelope<TreeScopeData>         & { action: "tree.expand" }
 *   | ToolResultEnvelope<SliceData>            & { action: "slice.build" }
 *   | ToolResultEnvelope<SliceRefreshData>     & { action: "slice.refresh" }
 *   | ToolResultEnvelope<SliceSpilloverGetData> & { action: "slice.spillover.get" }
 *   | ToolResultEnvelope<EditPlanData>         & { action: "edit.plan" }
 *   | ToolResultEnvelope<CodeSkeletonData>     & { action: "code.skeleton" }
 *   | ToolResultEnvelope<CodeHotPathData>      & { action: "code.lens" }
 *   | ToolResultEnvelope<CodeWindowData>       & { action: "code.window" }
 *   | ToolResultEnvelope<ContextData>          & { action: "context" }
 *   | ToolResultEnvelope<ContextSummaryData>   & { action: "context.summary" }
 *   | ToolResultEnvelope<AgentFeedbackData>    & { action: "agent.feedback" }
 *   | ToolResultEnvelope<AgentFeedbackQueryData> & { action: "agent.feedback.query" }
 *   | ToolResultEnvelope<DeltaData>            & { action: "review.delta" }
 *   | ToolResultEnvelope<PrRiskAnalyzeData>    & { action: "review.analyze" }
 *   | ToolResultEnvelope<PrRiskData>           & { action: "review.risk" }
 *   | ToolResultEnvelope<FileReadData>         & { action: "file.read" }
 *   | ToolResultEnvelope<MemoryStoreData>      & { action: "memory.store" }
 *   | ToolResultEnvelope<MemoryGetData>        & { action: "memory.get" }
 *   | ToolResultEnvelope<MemoryFeedbackData>   & { action: "memory.feedback" }
 *   | ToolResultEnvelope<MemorySurfaceData>    & { action: "memory.surface" }
 *   | ToolResultEnvelope<PolicyData>           & { action: "policy.get" }
 *   | ToolResultEnvelope<PolicyData>           & { action: "policy.set" }
 *   | ToolResultEnvelope<UsageStatsData>       & { action: "usage.stats" }
 *   | ToolResultEnvelope<RuntimeExecuteData>   & { action: "runtime.execute" }
 *   | ToolResultEnvelope<RuntimeQueryOutputData> & { action: "runtime.queryOutput" }
 *   | ToolResultEnvelope<ScipIngestData>       & { action: "scip.ingest" }
 * )} AnyToolResult
 */

/** Bumped on incompatible changes to any result shape above. */
export const ATLAS_TOOL_RESULT_SCHEMA_VERSION = 1;

// Runtime field-location catalog for consumers that parse ATLAS result payloads.
// Keep these paths beside the typedef contract so renderers/adapters do not
// bake in stale wire locations such as `slice.cards` after the public result
// shape has moved to top-level `cards`.
export const ATLAS_TOOL_RESULT_FIELD_CATALOG = Object.freeze({
  SymbolCard: Object.freeze({
    name: "name",
    kind: "kind",
    signature: "signature",
    summary: "summary",
    deps: "deps",
    metrics: "metrics",
    visibility: "visibility",
    filePath: "location.repo_rel_path",
    startLine: "location.startLine",
    endLine: "location.endLine",
  }),
  "slice.build": Object.freeze({
    sliceHandle: "sliceHandle",
    knownVersion: "knownVersion",
    cards: "cards",
    totalCardCount: "totalCardCount",
    wireFormat: "wireFormat",
    packed: "packed",
    spilloverHandle: "spilloverHandle",
  }),
  "edit.plan": Object.freeze({
    planId: "planId",
    edits: "edits",
    warnings: "warnings",
    nextActions: "nextActions",
  }),
  "tree.overview": Object.freeze({
    root: "root",
    matches: "matches",
    nodes: "nodes",
    total: "total",
    nextOffset: "nextOffset",
    areaMap: "areaMap",
  }),
  "tree.branch": Object.freeze({
    root: "root",
    matches: "matches",
    nodes: "nodes",
    total: "total",
    nextOffset: "nextOffset",
  }),
  "tree.scope": Object.freeze({
    candidateFiles: "candidateFiles",
    candidateDirs: "candidateDirs",
    refinementCandidates: "refinementCandidates",
    metrics: "metrics",
    scopeRisk: "metrics.scopeRisk",
    candidateFileCount: "metrics.candidateFileCount",
    estimatedTouchedFiles: "metrics.estimatedTouchedFiles",
    compression: "compression",
    compressionSeeds: "compression.matchedSeeds",
    compressionAreaMap: "compression.areaMap",
  }),
  "tree.expand": Object.freeze({
    candidateFiles: "candidateFiles",
    candidateDirs: "candidateDirs",
    refinementCandidates: "refinementCandidates",
    metrics: "metrics",
    scopeRisk: "metrics.scopeRisk",
    candidateFileCount: "metrics.candidateFileCount",
    estimatedTouchedFiles: "metrics.estimatedTouchedFiles",
    compression: "compression",
    compressionSeeds: "compression.matchedSeeds",
    compressionAreaMap: "compression.areaMap",
  }),
  "code.skeleton": Object.freeze({
    symbolId: "symbolId",
    filePath: "repo_rel_path",
    content: "content",
    startLine: "startLine",
    endLine: "endLine",
    truncated: "truncated",
    etag: "etag",
  }),
  "file.read": Object.freeze({
    filePath: "repo_rel_path",
    content: "content",
    totalBytes: "totalBytes",
    totalLines: "totalLines",
    returnedLines: "returnedLines",
    startLine: "startLine",
    truncated: "truncated",
  }),
});

/**
 * Return the public `data` payload for either a full ATLAS envelope or the
 * already-unwrapped payload returned by embedded ATLAS execution.
 *
 * @param {string} action
 * @param {unknown} result
 * @returns {Record<string, unknown> | null}
 */
export function atlasResultData(action, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const obj = /** @type {Record<string, unknown>} */ (result);
  if (
    obj.data
    && typeof obj.data === "object"
    && !Array.isArray(obj.data)
    && (
      obj.action === action
      || typeof obj.ok === "boolean"
      || typeof obj.versionId === "string"
    )
  ) {
    return /** @type {Record<string, unknown>} */ (obj.data);
  }
  return obj;
}

/**
 * @param {string} action
 * @param {string} field
 * @returns {string | null}
 */
export function atlasResultFieldPath(action, field) {
  const entry = ATLAS_TOOL_RESULT_FIELD_CATALOG[action];
  const path = entry && entry[field];
  return typeof path === "string" ? path : null;
}

/**
 * @param {string} action
 * @param {unknown} result
 * @param {string} field
 * @returns {unknown}
 */
export function atlasResultField(action, result, field) {
  const data = atlasResultData(action, result);
  const fieldPath = atlasResultFieldPath(action, field);
  return fieldPath ? atlasValueAtPath(data, fieldPath) : undefined;
}

/**
 * @param {unknown} card
 * @param {string} field
 * @returns {unknown}
 */
export function atlasSymbolCardField(card, field) {
  const entry = ATLAS_TOOL_RESULT_FIELD_CATALOG.SymbolCard;
  const fieldPath = entry && entry[field];
  return fieldPath ? atlasValueAtPath(card, fieldPath) : undefined;
}

/**
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {unknown}
 */
export function atlasValueAtPath(value, fieldPath) {
  if (!value || typeof value !== "object") return undefined;
  let current = /** @type {unknown} */ (value);
  for (const part of String(fieldPath || "").split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = /** @type {Record<string, unknown>} */ (current)[part];
  }
  return current;
}
