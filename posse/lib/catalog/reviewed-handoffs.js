// Local, versioned completion and ownership journal. These records must remain
// readable with admission disabled until the imported branches have settled.
export const REVIEWED_HANDOFF_VERSION = 1;
export const REVIEWED_HANDOFF_SETTING = "scheduler_reviewed_file_handoffs";
export const REVIEWED_COMPLETION_KEY = "_reviewed_file_completion";
export const REVIEWED_SOURCE_MERGE_KEY = "reviewed_file_source_merge";
export const REVIEWED_HANDOFF_REF_PREFIX = "refs/posse/reviewed-completions/";
export const REVIEWED_HANDOFF_TRAILER = "Posse-Reviewed-Transfer";
export const REVIEWED_SOURCE_TRAILER = "Posse-Reviewed-Source";
export const REVIEWED_REFRESH_TASK = "prepareReviewedTargetRefresh";
export const REVIEWED_REFRESH_REF_PREFIX = "refs/posse/reviewed-refresh/";
export const REVIEWED_HANDOFF_STATES = Object.freeze({
  RESERVED: "reserved", APPLYING: "applying", APPLIED: "applied", BLOCKED: "blocked", CANCELED: "canceled",
});
export const REVIEWED_HANDOFF_TRANSITIONS = Object.freeze({
  reserved: ["applying", "applied", "blocked", "canceled"],
  applying: ["applied", "blocked"],
  blocked: ["applying", "applied", "canceled"],
  applied: [], canceled: [],
});
export const REVIEWED_HANDOFF_REASONS = Object.freeze({
  INCOMPLETE: "reviewed_handoff_incomplete_proof",
  GENERATION: "upstream_generation_changed",
  SOURCE: "reviewed_handoff_source_invalid",
  SCOPE: "reviewed_handoff_scope_incomplete",
  INPUT: "reviewed_handoff_input_mismatch",
  DESTINATION: "reviewed_handoff_destination_changed",
  LEASE: "reviewed_handoff_lease_lost",
  RECOVERY: "reviewed_handoff_reconciliation_required",
});

// Fixed telemetry vocabulary. No paths, error text, or lease tokens belong in
// aggregate handoff measurements.
export const REVIEWED_HANDOFF_OUTCOMES = Object.freeze({
  COPIED: "copied", RESUMED: "resumed", RECOVERED: "recovered_commit",
  INTEGRATED: "integrated_target", PRESENT: "already_present",
  UNUSED: "canceled_unused", RESTORED: "canceled_restored",
});
export const REVIEWED_HANDOFF_OPERATION_OUTCOMES = Object.freeze([
  "completed", "deferred", "fallback", "unchanged", "failed",
]);
export const REVIEWED_HANDOFF_OPERATION_REASONS = Object.freeze([
  ...Object.values(REVIEWED_HANDOFF_REASONS), "WORKTREE_ACTIVE_SIBLING_LOCKS",
  "already_on_target", "dirty_receiver", "operation_in_progress",
  "missing_sync_commit", "sync_parent_mismatch", "sync_scope_mismatch",
  "sync_object_mismatch", "incomplete_git_proof", "no_settled_copies",
  "clean_replay_declined", "aborted", "other",
]);
