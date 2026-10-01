// Stable repository verification admission diagnostics.
export const TEST_SCRIPT_NO_VERIFICATION_REASON = "test_script_has_no_verification";
export const VERIFICATION_DEPENDENCY_LOCK_INVALID = "verification_dependency_lock_invalid";
export const DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY = "allow";

// Job payload key recording that a planner test command already failed before
// the job changed anything (baseline debt): it cannot verify the job. Written
// by worker/functions/helpers/baseline-test-debt.js; auto-merge reads it to
// decide when a work item needs operator review (merge-verification-review.js).
export const BASELINE_TEST_DEBT_PAYLOAD_KEY = "_baseline_test_debt";
