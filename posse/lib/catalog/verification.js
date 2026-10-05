// Stable repository verification admission diagnostics.
export const TEST_SCRIPT_NO_VERIFICATION_REASON = "test_script_has_no_verification";
export const VERIFICATION_DEPENDENCY_LOCK_INVALID = "verification_dependency_lock_invalid";
export const DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY = "allow";

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
