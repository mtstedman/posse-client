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
//   * `lib/domains/worker/functions/helpers/job-type-sets.js` — sets below
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
//   * `max_runtime_ms: 60_000` — bounded; if it can't finish in 60s the
//                             dev job will fall back to clone-from-main.
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
 *   | "main-incremental"  // Reindex paths changed since last main warm.
 *   | "main-merge"        // Replay a WI ledger branch onto main, then refresh main view.
 *   | "main-full"         // Full reindex of main (rare; admin-triggered).
 *   | "scip-restage"      // Refresh staged SCIP artifacts without rebuilding a view.
 * )} AtlasWarmPurpose
 */

/**
 * @typedef {Object} AtlasWarmJobPayload
 * @property {AtlasWarmPurpose} purpose
 * @property {number} [work_item_id]          Required iff purpose === "wi".
 * @property {string} [branch]                The branch this warm targets. Defaults to "main" for main-* purposes.
 * @property {string} [onto_branch]           Destination branch for "main-merge". Defaults to "main".
 * @property {string[]} [paths]               Canonical repo-relative paths. Required iff purpose === "main-incremental"; optional hint when purpose === "wi".
 * @property {number} [from_seq]              For "main-incremental": only consider deltas after this ledger seq.
 * @property {string} [out_view_path]         Absolute filesystem path where the resulting view file should be written. Required for "wi" purpose; optional for main-* (defaults to <repo>/.posse/atlas/views/main.view.db).
 * @property {string} [trigger_event]         Originating event name (one of ATLAS_EVENTS values). Informational only.
 * @property {string} [language]              Optional SCIP language filter for purpose === "scip-restage".
 * @property {boolean} [force]                Force SCIP restage for purpose === "scip-restage".
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
 * @property {string} [embeddings_provider]   Encoder/index provider used for best-effort vector ingest.
 * @property {number} [embeddings_candidates] Symbols considered for vector ingest.
 * @property {number} [embeddings_indexed]    Symbols submitted to the embedding index.
 * @property {number} [embeddings_pruned]      Stale vector rows removed after modify/remove deltas.
 * @property {number} [embeddings_stale_dirs_removed] Old embedding index directories removed.
 * @property {string} [embeddings_skipped_reason] Reason embeddings were intentionally skipped.
 * @property {string} [embeddings_error]      Best-effort ingest error; view warming still succeeds.
 * @property {boolean} [truncated]            True when a hard warmer cap limited the scan.
 * @property {string} [truncation_reason]
 * @property {number} duration_ms
 * @property {AtlasWarmSkip[]} skipped          Files that could not be indexed.
 */

/**
 * @typedef {Object} AtlasWarmSkip
 * @property {string} repo_rel_path
 * @property {"unsupported_lang" | "read_error" | "parse_error" | "size_exceeded" | "minified_skip"} reason
 * @property {string} [message]
 */

// ============================================================================
// Status & runtime constants
// ============================================================================

/** Frozen status policy. Implementations and tests must source from here. */
export const ATLAS_WARM_JOB_POLICY = Object.freeze({
  jobType: "atlas_warm",
  assessable: false,
  mutating: false,
  escalating: false,
  maxAttempts: 1,
  maxRuntimeMs: 60_000,
  /**
   * Priority defaults for the scheduler. Warming should never preempt
   * pipeline work — it is strictly best-effort prefetch.
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
