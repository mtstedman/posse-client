// Event-domain catalogue.
//
// Two surfaces:
//   - EVENT_ACTOR_TYPES: actor identities stamped on events.actor_type;
//     constrained by a schema CHECK.
//   - EVENT_TYPES: the namespaced event_type string emitted on every
//     logEvent call. Not schema-constrained — typos at call sites used to
//     silently write malformed event types and break later filters. Always
//     use a constant from this map; new event types go here first.
//
// Naming convention: keys are SCREAMING_SNAKE_CASE of the underlying string
// with `.` replaced by `_`. Values are the literal strings persisted to
// the events table, kept intact so historical queries still match.

const sqlList = (values) => values.map((v) => `'${v}'`).join(", ");

export const EVENT_ACTOR_TYPES = Object.freeze([
  "system",
  "scheduler",
  "planner",
  "researcher",
  "dev",
  "assessor",
  "human",
  "worker",
  "delegator",
  "artificer",
  "preflight",
  "atlas",
]);
export const EVENT_ACTOR_TYPE_LIST_SQL = sqlList(EVENT_ACTOR_TYPES);

// Stable, bounded activity envelope shared by durable events and the bridge.
// Consumers must ignore unknown protocol versions instead of guessing from
// free-form event messages.
export const AGENT_ACTIVITY_PROTOCOL_VERSION = 1;
export const AGENT_ACTIVITY_PROTOCOL = `posse.agent_activity.v${AGENT_ACTIVITY_PROTOCOL_VERSION}`;
export const AGENT_ACTIVITY_KINDS = Object.freeze([
  "phase",
  "model",
  "progress",
  "result",
  "error",
]);
export const AGENT_ACTIVITY_STATUSES = Object.freeze([
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);
export const AGENT_ACTIVITY_LIMITS = Object.freeze({
  PHASE_CHARS: 80,
  SUMMARY_CHARS: 180,
  DETAIL_CHARS: 360,
  PROVIDER_CHARS: 80,
  MODEL_CHARS: 120,
});

// Namespaced alias used at logEvent call sites. Same typo-safety story as
// EVENT_TYPES — schema does CHECK actor_type, but failing at INSERT time
// is still later than failing at import.
export const EVENT_ACTORS = Object.freeze(
  Object.fromEntries(EVENT_ACTOR_TYPES.map((t) => [t.toUpperCase(), t])),
);

export const EVENT_TYPES = Object.freeze({
  // ── artifacts ───────────────────────────────────────────────────────────
  ARTIFACTS_TRANSIENT_DIRS_CLEANED: "artifacts.transient_dirs_cleaned",

  // ── bridge ──────────────────────────────────────────────────────────────
  BRIDGE_COMMAND_MUTATION: "bridge.command_mutation",

  // ── context / citation store ───────────────────────────────────────────
  CONTEXT_BOUNDED_INGRESS: "context.bounded_ingress",
  HASH_REF_FETCH: "hash_ref.fetch",
  HASH_REF_PINNED_PRESSURE: "hash_ref.pinned_pressure",

  // ── assessor ────────────────────────────────────────────────────────────
  ASSESSOR_SPAWN_JOB_SKIPPED: "assessor.spawn_job_skipped",

  // ── attempt ─────────────────────────────────────────────────────────────
  ATTEMPT_ORPHAN_RECONCILED: "attempt.orphan_reconciled",

  // ── agent_call ──────────────────────────────────────────────────────────
  AGENT_CALL_ORPHAN_RECONCILED: "agent_call.orphan_reconciled",

  // ── agent interaction / monitor agents ─────────────────────────────────
  AGENT_ACTIVITY: "agent.activity",
  AGENT_INTERACTION_APPLIED: "agent_interaction.applied",
  AGENT_INTERACTION_CREATED: "agent_interaction.created",
  AGENT_QUESTION_ANSWERED: "agent_question.answered",
  AGENT_QUESTION_CREATED: "agent_question.created",
  OPERATOR_NUDGE_APPLIED: "operator_nudge.applied",
  OPERATOR_NUDGE_CREATED: "operator_nudge.created",
  OPERATOR_NUDGE_EXPIRED: "operator_nudge.expired",
  OPERATOR_NUDGE_REQUEUED: "operator_nudge.requeued",

  // ── one-shot routing ───────────────────────────────────────────────────
  ONESHOT_DEMOTED: "oneshot.demoted",
  ONESHOT_FIX_SCOPE_GATED: "oneshot.fix_scope_gated",
  ONESHOT_SCOPE_CANDIDATES: "oneshot.scope_candidates",
  ONESHOT_SCOPE_SELECTION_REQUESTED: "oneshot.scope_selection_requested",
  ONESHOT_SCOPE_SELECTION_RESOLVED: "oneshot.scope_selection_resolved",

  // ── cleanup ─────────────────────────────────────────────────────────────
  CLEANUP_BRANCH_DISCARDED: "cleanup.branch_discarded",
  CLEANUP_BRANCH_SNAPSHOT_RESTORED: "cleanup.branch_snapshot_restored",
  CLEANUP_SNAPSHOT_DIFF_APPLIED: "cleanup.snapshot_diff_applied",
  CLEANUP_SNAPSHOT_DISCARDED: "cleanup.snapshot_discarded",
  CLEANUP_SNAPSHOT_RESTORED: "cleanup.snapshot_restored",
  CLEANUP_STASH_APPLIED: "cleanup.stash_applied",
  CLEANUP_STASH_DROPPED: "cleanup.stash_dropped",
  CLEANUP_WORKTREE_DISCARDED: "cleanup.worktree_discarded",

  // ── git ─────────────────────────────────────────────────────────────────
  GIT_BRANCH_CLEANUP_FAILED: "git.branch_cleanup_failed",
  GIT_BRANCH_PRESERVED: "git.branch_preserved",
  GIT_MERGE: "git.merge",
  GIT_PUSHED: "git.pushed",
  GIT_REVIEW_COMMIT_DIRTY: "git.review_commit_dirty",
  GIT_REVIEW_DISCARD_FILES: "git.review_discard_files",
  GIT_REVIEW_STASH_TARGET: "git.review_stash_target",
  GIT_TARGET_BRANCH_CLEARED: "git.target_branch_cleared",
  GIT_TARGET_BRANCH_SNAPSHOTTED: "git.target_branch_snapshotted",

  // ── job lifecycle & assessment ──────────────────────────────────────────
  JOB_ARTIFACT_EXISTING_OUTPUT_REUSED: "job.artifact_existing_output_reused",
  JOB_ARTIFACT_FAST_PASS: "job.artifact_fast_pass",
  JOB_ARTIFACT_REUSED: "job.artifact_reused",
  JOB_ARTIFACT_SCOPE_WARNING: "job.artifact_scope_warning",
  JOB_ASSESSED: "job.assessed",
  JOB_ASSESSMENT_FALSE_MISSING_OVERRIDE: "job.assessment_false_missing_override",
  JOB_ASSESSMENT_ENVIRONMENT_ERROR: "job.assessment_environment_error",
  JOB_ASSESSMENT_INTERNAL_RETRY: "job.assessment_internal_retry",
  JOB_ASSESSMENT_ORPHANED: "job.assessment_orphaned",
  JOB_ASSESSMENT_PARSE_ERROR: "job.assessment_parse_error",
  JOB_ASSESSMENT_PARSE_RETRY_BUDGET_EXCEEDED: "job.assessment_parse_retry_budget_exceeded",
  JOB_ASSESSMENT_PROVIDER_ERROR: "job.assessment_provider_error",
  JOB_ASSESSMENT_RETRY_PAYLOAD_PARSE_FAILED: "job.assessment_retry_payload_parse_failed",
  JOB_ASSESSMENT_TURN_BUDGET_EXHAUSTED: "job.assessment_turn_budget_exhausted",
  JOB_ASSESSMENT_TRANSPORT_ERROR: "job.assessment_transport_error",
  JOB_ASSESSOR_SUGGESTIONS_STORED: "job.assessor_suggestions_stored",
  JOB_ATTEMPT_FAILED: "job.attempt_failed",
  JOB_ATTEMPT_SKIPPED_STALE_LEASE: "job.attempt_skipped_stale_lease",
  JOB_BAD_INPUT: "job.bad_input",
  JOB_BLOCKED: "job.blocked",
  JOB_BRANCH_STALENESS_CHECK: "job.branch_staleness_check",
  JOB_CANCELED_BY_USER: "job.canceled_by_user",
  JOB_CANCELED_BY_REPLAN: "job.canceled_by_replan",
  JOB_CANCELED_BY_SUPERSEDING_PLAN: "job.canceled_by_superseding_plan",
  JOB_CANCELED_WITH_WORK_ITEM: "job.canceled_with_work_item",
  JOB_CATASTROPHIC_ERROR: "job.catastrophic_error",
  JOB_COMMIT_FAILED: "job.commit_failed",
  JOB_COMMIT_INFRA_RETRY: "job.commit_infra_retry",
  JOB_CREATED: "job.created",
  JOB_DEAD_LETTER_RECOVERY: "job.dead_letter_recovery",
  JOB_DEAD_LETTER_RECOVERY_FAILED: "job.dead_letter_recovery_failed",
  JOB_DEAD_LETTER_RECOVERY_SKIP: "job.dead_letter_recovery_skip",
  JOB_DEAD_LETTER_RETRY_SPAWNED: "job.dead_letter_retry_spawned",
  JOB_DEADLOCKED: "job.deadlocked",
  JOB_DELETE_NOOP_SATISFIED: "job.delete_noop_satisfied",
  JOB_DELETE_NOOP_SATISFIED_PRECOMMIT: "job.delete_noop_satisfied_precommit",
  JOB_DEPENDENCY_CYCLE: "job.dependency_cycle",
  JOB_DEPENDENCY_REMOVED: "job.dependency_removed",
  JOB_DEPENDENCY_REWIRE_FAILED: "job.dependency_rewire_failed",
  JOB_DEPENDENCY_REWIRED: "job.dependency_rewired",
  JOB_DROPPED_DUPLICATE_PROMOTE: "job.dropped_duplicate_promote",
  JOB_DROPPED_INVALID_PROMOTE: "job.dropped_invalid_promote",
  JOB_EMPTY_ARTIFACT: "job.empty_artifact",
  JOB_FILE_PLACEMENT_NOOP_SATISFIED: "job.file_placement_noop_satisfied",
  JOB_FILE_REQUEST_APPROVED: "job.file_request_approved",
  JOB_FILE_REQUEST_AUTO: "job.file_request_auto",
  JOB_FILE_REQUEST_DEPTH_LIMIT: "job.file_request_depth_limit",
  JOB_FILE_REQUEST_GATED: "job.file_request_gated",
  JOB_FILE_REQUEST_PARSED: "job.file_request_parsed",
  JOB_FILE_REQUEST_REJECTED: "job.file_request_rejected",
  JOB_FILE_REQUEST_SANITIZED_EMPTY: "job.file_request_sanitized_empty",
  JOB_SCOPE_REQUEST_APPROVED: "job.scope_request_approved",
  JOB_SCOPE_REQUEST_REJECTED: "job.scope_request_rejected",
  JOB_SCOPE_REQUESTED: "job.scope_requested",
  JOB_FIX_CHAIN_ESCALATION: "job.fix_chain_escalation",
  JOB_GIT_ERROR: "job.git_error",
  JOB_HEADLESS_APPROVAL_CANCELED: "job.headless_approval_canceled",
  JOB_HEADLESS_NON_HUMAN_WAITING_ON_HUMAN: "job.headless_non_human_waiting_on_human",
  JOB_HEADLESS_RECOVERY: "job.headless_recovery",
  JOB_HEADLESS_TIMEOUT: "job.headless_timeout",
  JOB_HOOK_VERIFY_FAILED: "job.hook_verify_failed",
  JOB_HUMAN_RESOLUTION_FAILED: "job.human_resolution_failed",
  JOB_HUMAN_PROMPT_REQUEUED: "job.human_prompt_requeued",
  JOB_LEASE_EXPIRED: "job.lease_expired",
  JOB_LEASE_RELEASED: "job.lease_released",
  JOB_LEASED: "job.leased",
  JOB_MERGE_COMPLETED: "job.merge_completed",
  JOB_MERGE_SCOPE_AUDIT: "job.merge_scope_audit",
  JOB_MERGE_SCOPE_AUDIT_FAILED: "job.merge_scope_audit_failed",
  JOB_NOOP_BYPASS_FILE_REQUEST: "job.noop_bypass_file_request",
  JOB_NOOP_BRANCH_DIFF_DETECTED: "job.noop_branch_diff_detected",
  JOB_NOOP_FAILURE: "job.noop_failure",
  JOB_NOOP_RETRY: "job.noop_retry",
  JOB_NUDGE_REQUEUED: "job.nudge_requeued",
  JOB_NUDGED: "job.nudged",
  JOB_ORPHAN_REQUEUE: "job.orphan_requeue",
  JOB_ORPHANED_REVIEW_PARKED: "job.orphaned_review_parked",
  JOB_ORPHANED_REVIEW_RECOVERY: "job.orphaned_review_recovery",
  JOB_OUTPUT_CONTRACT_FAILED: "job.output_contract_failed",
  JOB_OUTPUT_CONTRACT_SCOPE_UNUSED: "job.output_contract_scope_unused",
  JOB_PARTIAL_WORK_COMMITTED: "job.partial_work_committed",
  JOB_PARTIAL_WORK_DETECTED: "job.partial_work_detected",
  JOB_PARTIAL_WORK_PROMPTED: "job.partial_work_prompted",
  JOB_PARTIAL_WORK_RESUME_REQUESTED: "job.partial_work_resume_requested",
  JOB_PARTIAL_WORK_REVERTED: "job.partial_work_reverted",
  JOB_PLACEHOLDER_QUESTION_IGNORED: "job.placeholder_question_ignored",
  JOB_PROMOTE_COMPLETE: "job.promote_complete",
  JOB_PROMOTE_CONFLICT_PREVIEW: "job.promote_conflict_preview",
  JOB_PROMOTE_CROSS_WI_SOURCE: "job.promote_cross_wi_source",
  JOB_PROVIDER_CIRCUIT_OPEN: "job.provider_circuit_open",
  JOB_PROVIDER_ERROR: "job.provider_error",
  JOB_RATE_LIMITED: "job.rate_limited",
  JOB_REBASE_ABORT_FAILED: "job.rebase_abort_failed",
  JOB_REBASE_APPLIED: "job.rebase_applied",
  JOB_REBASE_CONFLICT: "job.rebase_conflict",
  JOB_REVIEW_RESOLVED: "job.review_resolved",
  JOB_REVIEW_RETRY_ASSESSMENT: "job.review_retry_assessment",
  JOB_REVIEW_RETRY_LIMIT: "job.review_retry_limit",
  JOB_REVIEW_SKIPPED: "job.review_skipped",
  JOB_RUNTIME_EXCEEDED: "job.runtime_exceeded",
  JOB_SCOPE_CLEANED_NOOP: "job.scope_cleaned_noop",
  JOB_SCOPE_COMPAT_CREATE_VIA_MODIFY: "job.scope_compat_create_via_modify",
  JOB_SCOPE_COMPAT_UNTRACKED_OUT_OF_SCOPE: "job.scope_compat_untracked_out_of_scope",
  JOB_SCOPE_GIT_ADD_WARNING: "job.scope_git_add_warning",
  JOB_SCOPE_IGNORED_CREATEFILES_SKIPPED: "job.scope_ignored_createfiles_skipped",
  JOB_SCOPE_IGNORED_MODIFYFILES_SKIPPED: "job.scope_ignored_modifyfiles_skipped",
  JOB_SCOPE_SIBLING_DIRTY_SKIPPED: "job.scope_sibling_dirty_skipped",
  JOB_SCOPE_STALE_MODIFYFILES_SKIPPED: "job.scope_stale_modifyfiles_skipped",
  JOB_SCOPE_UNTRACKED_OUT_OF_SCOPE_BLOCKED: "job.scope_untracked_out_of_scope_blocked",
  JOB_SCOPE_VIOLATION: "job.scope_violation",
  JOB_SHUTDOWN_INTERRUPTED: "job.shutdown_interrupted",
  JOB_SHUTDOWN_REQUEUE: "job.shutdown_requeue",
  JOB_SKIPPED: "job.skipped",
  JOB_STALE_LEASE_RELEASE: "job.stale_lease_release",
  JOB_STALL_KILLED: "job.stall_killed",
  JOB_STALL_RECOVERY_CAP_REACHED: "job.stall_recovery_cap_reached",
  JOB_STATUS_CHANGED: "job.status_changed",
  JOB_VERIFIED_NO_CHANGE: "job.verified_no_change",
  JOB_SUGGESTION_APPROVED: "job.suggestion_approved",
  JOB_SUGGESTION_SKIPPED: "job.suggestion_skipped",
  JOB_TURN_BUDGET_RETRY_CAP_REACHED: "job.turn_budget_retry_cap_reached",
  JOB_TURN_BUDGET_RETRY_TUNED: "job.turn_budget_retry_tuned",
  JOB_UNBLOCKED: "job.unblocked",
  JOB_UNKNOWN_VERDICT: "job.unknown_verdict",
  JOB_WARM_LEASE_EXPIRED: "job.warm_lease_expired",
  JOB_WORKTREE_LOCK_TIMEOUT: "job.worktree_lock_timeout",
  JOB_WRITE_LOCK_BLOCKED: "job.write_lock_blocked",
  JOB_WRITE_LOCKS_ACQUIRED: "job.write_locks_acquired",

  // ── kaizen / memory ───────────────────────────────────────────────────
  KAIZEN_INSIGHTS_SURFACED: "kaizen.insights_surfaced",
  KAIZEN_MEMORY_FEEDBACK: "kaizen.memory_feedback",

  // ── pipeline ────────────────────────────────────────────────────────────
  PIPELINE_DUPLICATE_PLAN_SKIPPED: "pipeline.duplicate_plan_skipped",
  PIPELINE_DUPLICATE_RESEARCH_SKIPPED: "pipeline.duplicate_research_skipped",

  // ── packet ──────────────────────────────────────────────────────────────
  PACKET_CONTEXT_TRIMMED: "packet.context_trimmed",
  PACKET_FILES_DROPPED: "packet.files_dropped",
  PACKET_PROMPT_TRUNCATED: "packet.prompt_truncated",

  // ── plan ────────────────────────────────────────────────────────────────
  PLAN_APPROVAL_GATE_CREATED: "plan.approval_gate_created",
  PLAN_APPROVAL_GATE_FAILED: "plan.approval_gate_failed",
  PLAN_APPROVED: "plan.approved",
  PLAN_DEPENDENCY_MISSING: "plan.dependency_missing",
  PLAN_RECOVERY_ESCALATED: "plan.recovery_escalated",
  PLAN_RED_TEAM_CHAIN_CREATED: "plan.red_team_chain_created",
  PLAN_REJECTED: "plan.rejected",
  PLAN_REPLAN_SPAWNED: "plan.replan_spawned",
  PLAN_SCOPE_REJECTED: "plan.scope_rejected",
  PLAN_TASK_CAPPED: "plan.task_capped",
  PLAN_TASK_INVALID: "plan.task_invalid",
  PLAN_TASK_SCOPE_WARNING: "plan.task_scope_warning",

  // ── planner ─────────────────────────────────────────────────────────────
  PLANNER_RESEARCH_PATHS_DROPPED: "planner.research_paths_dropped",

  // ── preflight ───────────────────────────────────────────────────────────
  PREFLIGHT_FALLBACK: "preflight.fallback",
  PREFLIGHT_ROUTED: "preflight.routed",

  // ── research ────────────────────────────────────────────────────────────
  RESEARCH_FANOUT_CHILD_COMPLETED: "research.fanout_child_completed",
  RESEARCH_FANOUT_CHILD_TIMED_OUT: "research.fanout_child_timed_out",
  RESEARCH_FANOUT_SHADOWED: "research.fanout_shadowed",
  RESEARCH_FANOUT_SKIPPED: "research.fanout_skipped",
  RESEARCH_FANOUT_STARTED: "research.fanout_started",
  RESEARCH_FANOUT_SYNTH_COMPLETED: "research.fanout_synth_completed",
  RESEARCH_ROUTING: "research.routing",
  RESEARCH_ROUTING_SHADOW: "research.routing_shadow",
  RESEARCH_SKIPPED: "research.skipped",

  // ── scheduler ───────────────────────────────────────────────────────────
  SCHEDULER_LOCK_LOST_WORKER_ABORT: "scheduler.lock_lost_worker_abort",
  SCHEDULER_LOCK_RENEWAL_FAILED: "scheduler.lock_renewal_failed",
  SCHEDULER_LOCK_STARVED: "scheduler.lock_starved",
  SCHEDULER_LOOP_ERROR: "scheduler.loop_error",
  SCHEDULER_NO_PROGRESS: "scheduler.no_progress",
  SCHEDULER_RUN_LOOP_NOT_BOOTED: "scheduler.run_loop_not_booted",
  SCHEDULER_SCOPE_WOULD_HAVE_CONFLICTED: "scheduler.scope_would_have_conflicted",
  SCHEDULER_STARTED: "scheduler.started",
  SCHEDULER_STOPPED: "scheduler.stopped",
  SCHEDULER_WORKER_ERROR: "scheduler.worker_error",
  SCHEDULER_WORKER_WEDGED: "scheduler.worker_wedged",
  SCHEDULER_WORKERS_ABANDONED: "scheduler.workers_abandoned",
  SCHEDULER_WORKERS_LEFT_AFTER_LOCK_LOSS: "scheduler.workers_left_after_lock_loss",

  // ── atlas ─────────────────────────────────────────────────────────────────
  ATLAS_REINDEX_COMPLETED: "atlas.reindex_completed",
  ATLAS_REINDEX_FAILED: "atlas.reindex_failed",
  ATLAS_REINDEX_SKIPPED: "atlas.reindex_skipped",
  ATLAS_REINDEX_STARTED: "atlas.reindex_started",
  ATLAS_REINDEX_STATUS: "atlas.reindex_status",
  ATLAS_FEEDBACK_TASK_TEXT_MATCH: "atlas.feedback_task_text_match",
  ATLAS_FRESHNESS_GATE_DEFERRED: "atlas.freshness_gate.deferred",
  ATLAS_FRESHNESS_GATE_DEGRADED: "atlas.freshness_gate.degraded",
  ATLAS_WARM_COMPLETED: "atlas.warm_completed",
  ATLAS_SCIP_INGEST_STARTED: "atlas.scip.ingest.started",
  ATLAS_SCIP_INGEST_COMPLETED: "atlas.scip.ingest.completed",
  ATLAS_SCIP_INGEST_FAILED: "atlas.scip.ingest.failed",
  ATLAS_SCIP_INGEST_SKIPPED: "atlas.scip.ingest.skipped",
  ATLAS_SCIP_INDEX_PRODUCED: "atlas.scip.index.produced",
  ATLAS_SCIP_RESTAGE_DECIDED: "atlas.scip.restage_decided",
  ATLAS_SCIP_RESTAGE_STARTED: "atlas.scip.restage_started",
  ATLAS_SCIP_RESTAGE_COMPLETED: "atlas.scip.restage_completed",
  ATLAS_SCIP_RESTAGE_FAILED: "atlas.scip.restage_failed",
  ATLAS_SCIP_RESTAGE_SKIPPED: "atlas.scip.restage_skipped",

  // ── system ──────────────────────────────────────────────────────────────
  SYSTEM_PREFLIGHT_PROBE: "system.preflight_probe",
  SYSTEM_SCHEMA_JSON_REPAIRED: "system.schema_json_repaired",

  // ── session (non-namespaced legacy strings) ─────────────────────────────
  SESSION_ACQUIRED: "session_acquired",
  SESSION_ADVANCED: "session_advanced",
  SESSION_EXPIRED: "session_expired",
  SESSION_FAILED: "session_failed",
  SESSION_INVALIDATED: "session_invalidated",
  SESSION_LANE_LOCKED: "session_lane_locked",
  SESSION_LEASE_EXPIRED: "session_lease_expired",

  // ── skill (non-namespaced legacy strings) ───────────────────────────────
  SKILL_ATTACHED: "skill_attached",
  SKILL_INFERRED: "skill_inferred",
  SKILL_SKIPPED_DISABLED: "skill_skipped_disabled",
  SKILL_SKIPPED_UNKNOWN: "skill_skipped_unknown",
  SKILL_TRUNCATED: "skill_truncated",

  // ── work_item ───────────────────────────────────────────────────────────
  WORK_ITEM_APPROVED: "work_item.approved",
  WORK_ITEM_CANCELED: "work_item.canceled",
  WORK_ITEM_COMPLETION_BLOCKED: "work_item.completion_blocked",
  WORK_ITEM_CREATED_FROM_SUGGESTION: "work_item.created_from_suggestion",
  WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED: "work_item.cross_wi_file_handoff_blocked",
  WORK_ITEM_CROSS_WI_FILE_HANDOFF_PREPARED: "work_item.cross_wi_file_handoff_prepared",
  WORK_ITEM_CROSS_WI_FILE_HANDOFF_ROLLED_BACK: "work_item.cross_wi_file_handoff_rolled_back",
  WORK_ITEM_CROSS_WI_FILE_SYNC_APPLIED: "work_item.cross_wi_file_sync_applied",
  WORK_ITEM_CROSS_WI_FILE_SYNC_SKIPPED: "work_item.cross_wi_file_sync_skipped",
  WORK_ITEM_CROSS_WI_MERGE_DEPENDENCIES_CLEARED: "work_item.cross_wi_merge_dependencies_cleared",
  WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_REMOVED: "work_item.cross_wi_merge_dependency_removed",
  WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_STALE: "work_item.cross_wi_merge_dependency_stale",
  WORK_ITEM_DELETED: "work_item.deleted",
  WORK_ITEM_ESCALATION: "work_item.escalation",
  WORK_ITEM_ITERATION_FINISHED: "work_item.iteration_finished",
  WORK_ITEM_ITERATION_PASS_MERGED: "work_item.iteration_pass_merged",
  WORK_ITEM_ITERATION_STARTUP_SANITIZED: "work_item.iteration_startup_sanitized",
  WORK_ITEM_ITERATION_SPAWNED: "work_item.iteration_spawned",
  WORK_ITEM_MERGE_DEFERRED: "work_item.merge_deferred",
  WORK_ITEM_MERGE_FAILED: "work_item.merge_failed",
  WORK_ITEM_MERGED: "work_item.merged",
  WORK_ITEM_INTAKE_HINTS_CORRECTED: "work_item.intake_hints_corrected",
  WORK_ITEM_METADATA_PARSE_ERROR: "work_item.metadata_parse_error",
  WORK_ITEM_REJECTED: "work_item.rejected",
  WORK_ITEM_STATUS_CHANGED: "work_item.status_changed",
  WORK_ITEM_STATUS_TRANSITION_REJECTED: "work_item.status_transition_rejected",

  // ── worker ──────────────────────────────────────────────────────────────
  WORKER_FINALIZER_FAILED: "worker.finalizer_failed",
  WORKER_SCRATCH_GC: "worker.scratch_gc",
  WORKER_SETUP_CLEANUP_TIMING: "worker.setup.cleanup_timing",
  WORKER_SETUP_PHASE_FINISHED: "worker.setup.phase_finished",
  WORKER_SETUP_PHASE_STARTED: "worker.setup.phase_started",
  WORKER_SETUP_SUMMARY: "worker.setup.summary",

  // ── worktree ────────────────────────────────────────────────────────────
  WORKTREE_BRANCH_MISMATCH: "worktree.branch_mismatch",
  WORKTREE_BRANCH_RECREATED: "worktree.branch_recreated",
  WORKTREE_CLEANUP_FAILED: "worktree.cleanup_failed",
  WORKTREE_DIRTY_CLASSIFIED: "worktree.dirty_classified",
  WORKTREE_DIRTY_CLEANUP_DEFERRED: "worktree.dirty_cleanup_deferred",
  WORKTREE_DIRTY_RECOVERED: "worktree.dirty_recovered",
  WORKTREE_EXTERNAL_DRIFT_DETECTED: "worktree.external_drift_detected",
  WORKTREE_PRE_ASSESS_DIRTY: "worktree.pre_assess_dirty",
  WORKTREE_RESET_INCOMPLETE: "worktree.reset_incomplete",
  WORKTREE_SHUTDOWN_SWEEP_INCOMPLETE: "worktree.shutdown_sweep_incomplete",
  WORKTREE_SNAPSHOT_WARNING: "worktree.snapshot_warning",
  WORKTREE_STALE_HEAD_RESET: "worktree.stale_head_reset",
  WORKTREE_TERMINAL_SNAPSHOT: "worktree.terminal_snapshot",
  WORKTREE_UNTRACKED_RESIDUAL_TOLERATED: "worktree.untracked_residual_tolerated",
});
