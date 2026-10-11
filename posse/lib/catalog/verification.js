// Stable repository verification admission diagnostics.
export const TEST_SCRIPT_NO_VERIFICATION_REASON = "test_script_has_no_verification";
export const VERIFICATION_DEPENDENCY_LOCK_INVALID = "verification_dependency_lock_invalid";
export const DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY = "allow";

// A merge candidate may proceed past an unavailable runner, but a process
// that started and failed to finish has not supplied advisory evidence.
export const MERGE_CHECK_FAILURE_KINDS = Object.freeze({
  MISSING_RUNNER: "missing_runner",
  NO_TESTS: "no_tests",
  TIMEOUT: "timeout",
  SIGNAL: "signal",
  OUTPUT_OVERFLOW: "output_overflow",
  SPAWN_ERROR: "spawn_error",
  TEST_FAILURE: "test_failure",
});

// Includes target comparison, one candidate rerun, and any isolation proof;
// the enclosing git workflow has a 15-minute wall limit.
export const MERGE_GATE_WALL_BUDGET_MS = 12 * 60_000;

// Job payload key recording that a planner test command already failed before
// the job changed anything (baseline debt): it cannot verify the job. Written
// by worker/functions/helpers/baseline-test-debt.js; auto-merge reads it to
// decide when a work item needs operator review (merge-verification-review.js).
export const BASELINE_TEST_DEBT_PAYLOAD_KEY = "_baseline_test_debt";

// Deterministic test-execution receipts: `log` artifacts with this media type
// whose content carries this kind. Written by
// worker/functions/helpers/test-execution-receipt.js; merge verification and
// its review gate read them (queue/functions/verification-receipts.js).
export const TEST_EXECUTION_RECEIPT_MIME_TYPE = "application/vnd.posse.test-execution+json";
export const TEST_EXECUTION_RECEIPT_KIND = "deterministic_test_execution";
export const TEST_EXECUTION_REUSE_KIND = "verification_receipt_reuse";

// Non-discriminating receipt deltas cannot independently support a high
// assessment rating. The ceiling and high-floor adjustment share one policy.
export const RECEIPT_CONFIDENCE_POLICY = Object.freeze(Object.fromEntries(
  ["pass_to_pass", "persistent_failure", "post_only", "baseline_only"]
    .map((delta) => [delta, Object.freeze({ ceiling: "medium", high_floor: "medium" })]),
));
