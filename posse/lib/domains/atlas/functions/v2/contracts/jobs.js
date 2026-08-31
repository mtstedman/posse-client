// @ts-check
//
// Contracts for the `atlas_warm` job type that posse's scheduler will run.
// Workstream E implements the role class; Workstream A implements the
// indexer the role calls. This file is the seam between them.
//
// Integration surface (Workstream E owns):
//   * `lib/domains/worker/classes/roles/atlas-warm.js`   — new AtlasWarmRole class
//   * `lib/domains/worker/classes/role-classes.js`     — register AtlasWarmRole
//   * `lib/domains/worker/classes/Worker.js`           — _dispatch switch + _workerTypeFor
//   * `lib/catalog/job.js` — sets below
//   * Host schema migration: see ddl/host-migrations/001-add-atlas-warm-job-type.sql
//
// Status semantics (locked):
//   * `assessable: false`  — warming never triggers an assessor.
//   * `mutating:  false`   — never touches repo files; views are caches.
//   * `escalating: false`  — no model-tier escalation; this is deterministic.
//   * `max_attempts: 1`    — failure is silent; the next pipeline event
//                             re-emits and re-enqueues. Don't retry the
//                             same warm because the underlying ledger
//                             state may have moved.
//   * `max_runtime_ms: 180_000` — bounded; gives active-path warms room to
//                             finish under local ONNX / Windows load before
//                             callers fall back to clone-from-main.
//   * `work_item_id: nullable` — main-incremental and main-full warms have
//                             no owning WI; per-WI warms carry the wi_id.
//   * `provider: null`, `model_*: null`, `reasoning_effort: null` —
//                             not an LLM call. Scheduler must not require
//                             provider availability to lease.

// ============================================================================
// Job payload (stored in jobs.payload_json)
// ============================================================================

/**
 * @typedef {(
 *   "wi"                  // Warm a view for a specific WI from researcher hint.
 *   | "wi-cleanup"        // Tear down a terminal WI's warmed + worktree views.
 *   | "wi-snapshot"       // Clone one exact published main generation into a WI-keyed parked slot.
 *   | "wi-catchup"        // View-only bounded tail/clone to an exact published generation.
 *   | "wi-prefetch"       // Touch bounded hot-path neighborhoods on a final mounted view.
 *   | "main-incremental"  // Reindex paths changed since last main warm.
 *   | "main-merge"        // Replay a WI ledger branch onto main, then refresh main view.
 *   | "main-full"         // Full reindex of main (rare; admin-triggered).
 *   | "scip-restage"      // Refresh staged SCIP artifacts without rebuilding a view.
 *   | "embeddings"        // Budget-sliced vector index resume against an existing view; re-enqueues itself until parity.
 * )} AtlasWarmPurpose
 */

/**
 * @typedef {Object} AtlasWarmJobPayload
 * @property {AtlasWarmPurpose} purpose
 * @property {number} [work_item_id]          Required for WI-keyed warm/snapshot/catch-up operations.
 * @property {string} [branch]                The branch this warm targets. Defaults to "main" for main-* purposes.
 * @property {string} [target_branch]         Exact source-proof target branch override for main-* purposes.
 * @property {string} [git_oid]               Expected exact target OID; publication fails closed if the branch moved.
 * @property {string} [target_git_oid]        Legacy alias for git_oid.
 * @property {Record<string, unknown>} [source_proof] Internal pre-gate source proof passed by threaded warm owners holding the root lock.
 * @property {boolean} [source_lock_held]      Internal assertion that the caller holds the root lock across intake closeout.
 * @property {string} [onto_branch]           Destination branch for "main-merge". Defaults to "main".
 * @property {string[]} [paths]               Canonical repo-relative paths. Required iff purpose === "main-incremental"; optional hint when purpose === "wi".
 * @property {boolean} [paths_truncated]      Set when a hint list overflowed a cap (executor clamp or coalescer union): the warm must run the freshness scan instead of indexing the silent subset.
 * @property {string[]} [resume_paths]        Internal durable-intake retry paths from the prior partial/interrupted attempt.
 * @property {boolean} [resume_repository_recheck] Internal marker requiring a repository freshness scan before the intake may close complete.
 * @property {boolean} [resume_paths_truncated] Internal marker that the durable retry path set overflowed and requires a repository freshness scan.
 * @property {number} [from_seq]              For "main-incremental": only consider deltas after this ledger seq.
 * @property {string} [out_view_path]         Absolute filesystem path where the resulting view file should be written. Required for "wi" purpose; optional for main-* (defaults to <repo>/.posse/atlas/views/main.view.db).
 * @property {string} [trigger_event]         Originating event name (one of ATLAS_EVENTS values). Informational only.
 * @property {string} [language]              Optional SCIP language filter for purpose === "scip-restage".
 * @property {boolean} [force]                Force SCIP restage for purpose === "scip-restage".
 * @property {number} [max_symbols]           For purpose === "embeddings": encode at most this many missing symbols in one slice (defaults to ATLAS_EMBEDDINGS_WARM_SLICE_SYMBOLS). Resume state lives in keys.db/inflight.json, so each slice picks up where the last stopped.
 * @property {import("../../../../../catalog/waiting-lane.js").WaitingLaneGeneration} [generation] Exact requested joint generation for wi-snapshot/wi-catchup and optional verification for wi-prefetch.
 * @property {number} [preparation_version]   Durable preparation CAS token echoed to the settlement adapter.
 * @property {number} [tail_entry_limit]      Measured policy threshold for bounded catch-up; omission selects exact clone.
 */

// ============================================================================
// Job result (stored in jobs.result_json on success)
// ============================================================================

/**
 * @typedef {Object} AtlasWarmJobResult
 * @property {AtlasWarmPurpose} purpose
 * @property {number} paths_considered
 * @property {number} paths_indexed
 * @property {number} blobs_ingested
 * @property {number} blobs_reused
 * @property {number} ledger_entries_appended
 * @property {string | null} view_written     Absolute path of the produced view file, or null if no view was materialized.
 * @property {string | null} view_etag        ViewMeta.built_at or a derived ETag.
 * @property {boolean} [view_reused]          True when an idempotent main merge proved the existing destination view current and reused it.
 * @property {string[]} [redundant_phases_skipped] Expensive phases omitted after a current-view proof.
 * @property {string} [embeddings_provider]   Encoder/index provider used for best-effort vector ingest.
 * @property {number} [embeddings_candidates] Symbols considered for vector ingest.
 * @property {number} [embeddings_indexed]    Symbols submitted to the embedding index.
 * @property {number} [embeddings_documentation_candidates] Symbols with documentation eligible for the documentation vector channel.
 * @property {number} [embeddings_documentation_indexed] Documentation vectors submitted to the embedding index.
 * @property {number} [embeddings_documentation_already_indexed] Documentation vectors already present.
 * @property {number} [embeddings_pruned]      Stale vector rows removed after modify/remove deltas.
 * @property {"full" | "incremental"} [embeddings_scope] Symbol scope used for ride-along embedding ingest.
 * @property {"full" | "incremental"} [embeddings_prune_scope] Orphan-prune mode used after ingest.
 * @property {string} [embeddings_watermark_reason] Watermark decision behind full vs incremental ingest.
 * @property {number} [embeddings_stale_dirs_removed] Old embedding index directories removed.
 * @property {string} [embeddings_skipped_reason] Reason embeddings were intentionally skipped.
 * @property {string} [embeddings_error]      Best-effort ingest error; view warming still succeeds.
 * @property {number} [embeddings_remaining]  For purpose === "embeddings": symbols still missing vectors after this slice.
 * @property {boolean} [embeddings_complete]  For purpose === "embeddings": true once the index reached parity (no missing symbols).
 * @property {boolean} [embeddings_deferred]  True when the warm produced the view but intentionally left vector parity for a later embeddings job.
 * @property {boolean} [embeddings_streaming] True when embedding intake ran concurrently with ordered document ingestion.
 * @property {{ ok: boolean, skipped?: string, profile?: string | null, deltaSeeds?: number | null, carriedForwardSeeds?: number | null, error?: string | null } | null} [tree_compression_reseed] Best-effort ML tree-compression reseed outcome.
 * @property {boolean} [scip_staged_fresh]    For purpose === "scip-restage": true when the restage staged fresh artifacts (not already-staged/no-op), so the executor can enqueue the main-incremental intake that consumes them.
 * @property {number} [scip_covered_parse_gaps] Number of Tree-sitter parse gaps discharged by an indexed SCIP layer for the exact same content hash.
 * @property {string[]} [scip_covered_parse_gap_paths] Repository-relative paths for those SCIP-covered parser gaps.
 * @property {AtlasRebuildRequirement} [rebuild_required] Native storage rejected an unsafe incremental refresh and requires the named rebuild scope.
 * @property {boolean} [rebuild_retry_attempted] Boot ownership reset rebuildable data and retried exactly once.
 * @property {boolean} [rebuild_recovered] The one-shot boot rebuild completed without another rebuild requirement.
 * @property {boolean} [truncated]            True when a hard warmer cap limited the scan.
 * @property {string} [truncation_reason]
 * @property {number} duration_ms
 * @property {AtlasWarmSkip[]} skipped          Files that could not be indexed.
 * @property {import("../../../../../catalog/waiting-lane.js").WaitingLaneGeneration} [generation] Published main generation or exact output generation.
 * @property {"ready" | "already_current" | "prefetched" | "needs_reprepare" | "superseded" | "needs_latest"} [waiting_lane_outcome]
 * @property {"snapshot" | "tail" | "clone" | "prefetch" | "none"} [waiting_lane_operation]
 * @property {number} [tail_entries]
 * @property {string} [waiting_lane_reason]
 * @property {number} [prefetched_symbols]
 * @property {number} [prefetched_edges]
 * @property {string} [generation_proof_reason]
 * @property {{ attempt_id: string, status: "complete" | "partial" | "failed", target_branch: string, git_oid: string | null, resume_count: number, resumed_from_status: string | null }} [intake] Durable main-index intake closeout summary. Interrupted attempts are persisted to `.posse/atlas/intake/main.json` and rethrown rather than returned.
 */

/**
 * @typedef {Object} AtlasWarmSkip
 * @property {string} repo_rel_path
 * @property {"unsupported_lang" | "read_error" | "parse_error" | "size_exceeded" | "minified_skip" | "generated_artifact_skip" | "symlink_skip" | "busy" | "infra_unavailable" | "rebuild_required"} reason
 * @property {string} [message]
 */

/**
 * @typedef {Object} AtlasRebuildRequirement
 * @property {"ledger"} scope
 * @property {string} contentHash
 * @property {"compiler_projection" | "cross_blob_exact_edge" | "compiler_projection_and_cross_blob_exact_edge"} reason
 */

// ============================================================================
// Status & runtime constants
// ============================================================================

/**
 * Deterministic source dispositions that still account for a path completely.
 * They remain visible in the intake receipt, but do not make an otherwise
 * exact main generation resumable. Read/parse/infra/rebuild failures are
 * intentionally absent and therefore keep closeout partial.
 */
export const ATLAS_MAIN_GENERATION_ACCOUNTED_SKIP_REASONS = Object.freeze([
  "unsupported_lang",
  "size_exceeded",
  "minified_skip",
  "generated_artifact_skip",
  // A symlink is excluded rather than dereferenced: Git proves only the
  // committed link text. The path is accounted because the exact view
  // contains no rows derived from it.
  "symlink_skip",
]);

/** Frozen status policy. Implementations and tests must source from here. */
export const ATLAS_WARM_JOB_POLICY = Object.freeze({
  jobType: "atlas_warm",
  assessable: false,
  mutating: false,
  escalating: false,
  maxAttempts: 1,
  maxRuntimeMs: 180_000,
  /**
   * Priority defaults for the scheduler. Warming should never preempt
   * pipeline work by default; active-path event hooks opt into higher
   * priority when freshness gates depend on the warm result.
   */
  defaultPriority: "low",
  /**
   * Whether a warm job can be canceled mid-flight when its target WI is
   * canceled or its view is no longer wanted. Used by the scheduler's
   * deadlock/cleanup pass.
   */
  cancelOnTargetGone: true,
});

/** @typedef {typeof ATLAS_WARM_JOB_POLICY} AtlasWarmJobPolicy */

/**
 * The string `jobs.job_type` value. Importers should reference this
 * constant rather than hardcoding "atlas_warm".
 */
export const ATLAS_WARM_JOB_TYPE = ATLAS_WARM_JOB_POLICY.jobType;

/**
 * Default encode budget for one "embeddings" warm slice. Sized so a slice
 * finishes well inside the warm runtime budget on a cold local-ONNX encoder;
 * a below-parity index re-enqueues another slice rather than stretching one
 * job, so the scheduler can interleave pipeline work between slices.
 */
export const ATLAS_EMBEDDINGS_WARM_SLICE_SYMBOLS = 4000;
