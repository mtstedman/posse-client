/** @typedef {import("../../../../../catalog/atlas-events.js").AtlasEventName} AtlasEventName */
import { ATLAS_EVENTS } from "../../../../../catalog/atlas-events.js";
export { ATLAS_EVENTS } from "../../../../../catalog/atlas-events.js";



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
 * @property {string | null} [worktree_path] Exact source checkout for the committed WI.
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
