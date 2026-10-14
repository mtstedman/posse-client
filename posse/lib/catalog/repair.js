// Operator repair contract. Database ownership stays in the local queue owner.
export const REPAIR_PROTOCOL = "posse.repair.v1";
export const REPAIR_ACTIONS = Object.freeze({
  RETRY_JOB: "retry_job",
  SKIP_JOB: "skip_job",
  WAIVE_ASSESSMENT: "waive_assessment",
  SET_SKIP_ASSESSMENT: "set_skip_assessment",
});
export const REPAIR_RECOVERY_KINDS = Object.freeze([
  "assessment_review", "assessment_transport_recovery", "assessment_retry_limit",
  "blocked_recovery", "dead_letter_recovery", "unexecuted_replan_recovery",
]);
export const REPAIR_MAX_RELATED = 100;
export const REPAIR_REJECTIONS = Object.freeze([
  "invalid_repair", "target_not_found", "repair_scope_too_large", "live_lease",
  "stale_repair_state", "work_item_closed", "use_original_job_or_question",
  "job_already_terminal", "gate_resolution_in_progress", "unsupported_related_gate",
  "cross_work_item_dependents", "implementation_not_complete_use_skip_job", "dependency_rewire_refused",
]);

// Automatic contract repair is bounded independently of ordinary fix chains.
export const CONTRACT_OWNER_REPAIR_LIMIT = 2;
