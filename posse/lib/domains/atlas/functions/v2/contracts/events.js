// @ts-check
//
// Frozen event-name constants for the ATLAS v2 pipeline. These are the wire
// between the pipeline-integration workstream (emits) and the warmer
// workstream (consumes). They live here so neither side can drift.
//
// The string values are stable identifiers — once published they may be
// observed by other tooling (logs, metrics, future external subscribers),
// so never change a value, only add new ones.

/**
 * @typedef {(
 *   "atlas.research_complete"
 *   | "atlas.dev_leased"
 *   | "atlas.dev_committed"
 *   | "atlas.merged_to_main"
 *   | "atlas.main_advanced"
 *   | "atlas.scip_restage_requested"
 *   | "atlas.wi_cleanup"
 *   | "atlas.embeddings_resume"
 *   | "atlas.self_repair"
 * )} AtlasEventName
 */

export const ATLAS_EVENTS = Object.freeze({
  /** Emitted when a researcher job succeeds. Payload: { wi_id, files: string[] }. Hint for view warming. */
  RESEARCH_COMPLETE: "atlas.research_complete",

  /** Emitted when a dev/fix/promote job is leased and a worktree is about to spawn. Payload: { wi_id, branch }. Triggers view mount. */
  DEV_LEASED: "atlas.dev_leased",

  /** Emitted after a dev/fix/promote job commits to the WI branch. Payload: { wi_id, branch, paths: string[] }. Triggers incremental reindex. */
  DEV_COMMITTED: "atlas.dev_committed",

  /** Emitted when a WI branch merges back into main. Payload: { wi_id, branch, target_branch }. Triggers ledger partition replay. */
  MERGED_TO_MAIN: "atlas.merged_to_main",

  /** Emitted when main advances (post-commit hook, external git pull, etc). Payload: { from_sha, to_sha, paths: string[] }. Triggers incremental main reindex. */
  MAIN_ADVANCED: "atlas.main_advanced",

  /** Emitted when staged SCIP artifacts should be refreshed. Payload: { to_sha, target_branch, reason }. Triggers a scip-restage warm job. */
  SCIP_RESTAGE_REQUESTED: "atlas.scip_restage_requested",

  /** Emitted when a standalone scip-restage staged FRESH artifacts. Staging alone never ingests (WI warms are hot-view-only and readiness reports staged as ready), so this triggers the main-incremental warm whose SCIP phase consumes the staged index — otherwise the symbols wait for the next unrelated main warm. Payload: { target_branch, reason }. */
  SCIP_STAGED: "atlas.scip_staged",

  /** Emitted when a WI is being purged. Payload: { wi_id, branch }. Triggers view file deletion; ledger partition is retained for audit. */
  WI_CLEANUP: "atlas.wi_cleanup",

  /** Emitted when the embedding index is below parity and its owner is gone (boot backgrounded/failed, crash). Payload: { target_branch, reason, remaining }. Triggers a budget-sliced embeddings warm that re-enqueues itself until coverage reaches parity. */
  EMBEDDINGS_RESUME: "atlas.embeddings_resume",

  /** Emitted when readiness inspection finds a non-ready layer with no live owner. Payload: { reason, layers }. The emitter supplies an explicit warm payload for the repair (e.g. main-full). */
  SELF_REPAIR: "atlas.self_repair",
});

/** Ordered tuple of all event names. Useful for switch exhaustiveness checks and metrics enumeration. */
export const ATLAS_EVENT_NAMES = Object.freeze(
  /** @type {readonly AtlasEventName[]} */ (Object.values(ATLAS_EVENTS)),
);

// ============================================================================
// Outbox row shape (locked at Phase 0.5)
// ============================================================================
//
// Pipeline integration writes one row to the existing `events` table per
// emission, in the SAME transaction that enqueues the corresponding
// `atlas_warm` job (transactional outbox). The events row is for audit /
// observability; the job row is what drives warming.
//
// Schema mapping into the existing events table:
//   event_type   = one of ATLAS_EVENTS values
//   actor_type   = "atlas"     (added by ddl/host-migrations/002-add-atlas-actor-type.sql)
//   actor_id     = null
//   work_item_id = payload.wi_id when present, else null
//   job_id       = the emitting job's id (for traceability)
//   event_json   = JSON-stringified payload matching the typedefs below
//
// Workstream E owns the emission points; Workstream F (warmer) owns the
// `atlas_warm` job that consumes the enqueue (not the events row directly).

/**
 * Generic outbox-row shape. Phase 1 consumers parse `event_json` based on
 * `event_type` and the typedefs below.
 *
 * @typedef {Object} AtlasOutboxRow
 * @property {number} id                      events.id
 * @property {AtlasEventName} event_type
 * @property {"atlas"} actor_type
 * @property {number | null} work_item_id
 * @property {number | null} job_id
 * @property {string} event_json              JSON-stringified AtlasEventPayload.
 * @property {string} created_at              ISO-8601.
 */

// ----------------------------------------------------------------------------
// Per-event payload typedefs. The `event_json` field decodes to one of these
// depending on `event_type`.
// ----------------------------------------------------------------------------

/**
 * @typedef {Object} ResearchCompletePayload
 * @property {number} wi_id
 * @property {string} branch                  Will be the WI's branch once the dev job creates the worktree.
 * @property {string[]} files                 Canonical repo-relative paths the researcher flagged as in-scope.
 * @property {string} [context_dir]           Absolute path to the researcher's context dir, for downstream prefetch.
 */

/**
 * @typedef {Object} DevLeasedPayload
 * @property {number} wi_id
 * @property {string} branch
 * @property {string} worktree_path           Absolute path to the just-created worktree.
 * @property {number} job_id                  The dev/fix/promote job that triggered the lease.
 */

/**
 * @typedef {Object} DevCommittedPayload
 * @property {number} wi_id
 * @property {string} branch
 * @property {string} commit_sha
 * @property {string[]} paths                 Canonical repo-relative paths touched by the commit.
 * @property {number} job_id
 */

/**
 * @typedef {Object} MergedToMainPayload
 * @property {number} wi_id
 * @property {string} source_branch
 * @property {string} target_branch
 * @property {string} merge_commit_sha
 */

/**
 * @typedef {Object} MainAdvancedPayload
 * @property {string} from_sha
 * @property {string} to_sha
 * @property {string[]} paths                 Canonical repo-relative paths changed in the range.
 * @property {string} [target_branch]
 * @property {string} [reason]
 * @property {"post_commit_hook" | "external_pull" | "merge" | "freshness_gate"} source
 */

/**
 * @typedef {Object} ScipRestageRequestedPayload
 * @property {string} to_sha
 * @property {string} target_branch
 * @property {string} reason
 * @property {"post_commit_hook" | "drift_reconciliation" | "manual"} [source]
 */

/**
 * @typedef {Object} WiCleanupPayload
 * @property {number} wi_id
 * @property {string} branch
 * @property {"merged" | "abandoned" | "purged"} disposition
 */

/**
 * @typedef {Object} EmbeddingsResumePayload
 * @property {string} target_branch
 * @property {string} reason                  Why the resume was requested (e.g. "boot_backgrounded", "warm_incomplete", "self_repair").
 * @property {number} [remaining]             Best-known count of symbols still missing vectors.
 */

/**
 * @typedef {Object} SelfRepairPayload
 * @property {string} reason                  The triggering condition (e.g. "boot_reindex_failed: ...").
 * @property {string[]} layers                Readiness layer names that were not ready.
 */

/**
 * Discriminated union of every event payload, keyed by event_type.
 *
 * @typedef {(
 *   { type: "atlas.research_complete" } & ResearchCompletePayload
 *   | { type: "atlas.dev_leased" } & DevLeasedPayload
 *   | { type: "atlas.dev_committed" } & DevCommittedPayload
 *   | { type: "atlas.merged_to_main" } & MergedToMainPayload
 *   | { type: "atlas.main_advanced" } & MainAdvancedPayload
 *   | { type: "atlas.scip_restage_requested" } & ScipRestageRequestedPayload
 *   | { type: "atlas.wi_cleanup" } & WiCleanupPayload
 *   | { type: "atlas.embeddings_resume" } & EmbeddingsResumePayload
 *   | { type: "atlas.self_repair" } & SelfRepairPayload
 * )} AtlasEventPayload
 */
