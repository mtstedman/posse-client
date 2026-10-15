import { readonlySet } from "./readonly-collections.js";

// Stable repository verification admission diagnostics.
export const TEST_SCRIPT_NO_VERIFICATION_REASON = "test_script_has_no_verification";
export const VERIFICATION_DEPENDENCY_LOCK_INVALID = "verification_dependency_lock_invalid";
export const DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY = "allow";
export const TEST_STRICTNESS = Object.freeze({ PERMISSIVE: "permissive", STRICT: "strict" });
export const TEST_STRICTNESS_VALUES = Object.freeze(Object.values(TEST_STRICTNESS));
export const DEFAULT_TEST_STRICTNESS = TEST_STRICTNESS.PERMISSIVE;
export const TEST_CAPABILITY_PRUNED_REASON = "test_harness_unavailable";
export const TEST_REQUIRED_FILE_MISSING_REASON = "required_test_file_missing";
export const TEST_RUNNER_REMOVED_REASON = "test_runner_removed";
export const UNRUNNABLE_TEST_REASONS = Object.freeze([
  TEST_CAPABILITY_PRUNED_REASON, "test_script_missing", "test_manifest_missing",
  "repository_test_script_missing", "unit_test_path_unavailable", "test_adapter_unavailable",
  "test_executable_unavailable", "phpunit_unavailable", "pytest_unavailable",
  "php_runner_unidentified", "python_runner_unidentified", "typescript_test_loader_unavailable",
  "project_test_runner_requires_declared_command", "test_browser_unavailable",
  "test_runner_missing", "test_prerequisite_unavailable",
]);
export const PERMISSIVE_TEST_OUTCOMES = Object.freeze([
  "runner_unavailable", "dependency_unavailable", "no_applicable_suite", "invalid_plan", "unsafe_command",
]);

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

// Merge gate bounds and closed sets (git/functions/workflow-merge.js and its
// helpers). The gate and the close-out test end this long before the merge
// worker's own deadline, leaving time to commit, run hooks and clean up.
export const MERGE_GATE_TASK_RESERVE_MS = 2 * 60_000;
// Temporary checkouts a merge registers under the OS temp directory. A merge
// interrupted mid-gate leaves them registered; recovery removes them.
export const BASELINE_CHECKOUT_PREFIX = "posse-baseline-";
export const MERGE_CANDIDATE_CHECKOUT_PREFIX = "posse-merge-check-";
export const MERGE_CLOSEOUT_WORKTREE_PREFIX = "posse-closeout-";
// Written under the target checkout's git dir just before `merge --squash`
// and removed on every exit of the merge; present only after an interrupt.
export const MERGE_IN_PROGRESS_MARKER = "posse-merge-in-progress";
// A check process that started and did not finish normally: never evidence.
export const MERGE_CHECK_ABNORMAL_FAILURE_KINDS = Object.freeze([
  MERGE_CHECK_FAILURE_KINDS.TIMEOUT,
  MERGE_CHECK_FAILURE_KINDS.SIGNAL,
  MERGE_CHECK_FAILURE_KINDS.OUTPUT_OVERFLOW,
  MERGE_CHECK_FAILURE_KINDS.SPAWN_ERROR,
]);
// Target comparison outcomes for a failed or unavailable merge check.
export const MERGE_TARGET_COMPARISON_OUTCOMES = Object.freeze({
  TARGET_DEBT: "target_debt",
  CHANGED_DEBT: "changed_debt",
  REGRESSION: "regression",
  FLAKY_SUSPECT: "flaky_suspect",
  UNVERIFIED: "unverified",
  TARGET_UNAVAILABLE: "target_unavailable",
});
// Outcomes that let the gate proceed under MERGE_TARGET_DEBT_AUTO_PROCEED.
export const MERGE_TARGET_PROCEEDING_OUTCOMES = Object.freeze([
  MERGE_TARGET_COMPARISON_OUTCOMES.TARGET_DEBT,
  MERGE_TARGET_COMPARISON_OUTCOMES.CHANGED_DEBT,
  MERGE_TARGET_COMPARISON_OUTCOMES.TARGET_UNAVAILABLE,
]);
// Outcomes whose introducer is recorded as target debt on the push offer.
export const MERGE_TARGET_DEBT_OUTCOMES = Object.freeze([
  MERGE_TARGET_COMPARISON_OUTCOMES.TARGET_DEBT,
  MERGE_TARGET_COMPARISON_OUTCOMES.CHANGED_DEBT,
]);
// Stored gate evidence (recovery gate payload, merge events) keeps only the
// tail of each check's output and a bounded number of results.
export const MERGE_GATE_STORED_OUTPUT_CHARS = 4000;
export const MERGE_GATE_STORED_RESULTS = 20;
// Each failed-check line of a merge recovery gate's question.
export const MERGE_GATE_PROMPT_LINE_CHARS = 600;
// The debt attribution range starts at the newest passing receipt for the
// same check, found among this many receipts and commits.
export const MERGE_DEBT_RANGE_RECEIPT_ROWS = 256;
export const MERGE_DEBT_RANGE_RECEIPT_COMMITS = 32;
// A merge review approval rebound across content-preserving close-out
// refreshes keeps this many refresh records as its audit trail.
export const MERGE_REVIEW_REFRESH_AUDIT_LIMIT = 20;

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
// The runner completed a discovered test file, but emitted no case count.
export const TEST_FILE_INVOKED_COVERAGE_STATUS = "test_file_invoked";
// Unit-test runners (toolkit/unit-test-runner.js) whose invocation executes
// exactly the named file, so a pass with output shows that file ran. Go runs
// the file's whole package (a build tag can drop the file) and Cargo a named
// target; those need a parsed case count, as does a repository script.
export const SINGLE_FILE_TEST_RUNNERS = Object.freeze([
  "node_test", "pytest", "phpunit", "python_script", "php_script", "ruby",
]);

// Every before/after delta a test receipt pair can report
// (testExecutionDelta, plus typecheck scope attribution).
export const RECEIPT_DELTAS = Object.freeze([
  "pass_to_pass", "fixed", "regression", "persistent_failure", "changed_failure",
  "post_only", "baseline_only", "infrastructure_unavailable", "indeterminate", "out_of_scope_failure",
]);

// Non-discriminating receipt deltas cannot independently support a high
// assessment rating. The ceiling and high-floor adjustment share one policy;
// every delta has an explicit row. `null` leaves the rating alone: the delta
// discriminates, or decides the verdict itself.
const MEDIUM_RECEIPT_CONFIDENCE = Object.freeze({ ceiling: "medium", high_floor: "medium" });
export const RECEIPT_CONFIDENCE_POLICY = Object.freeze({
  pass_to_pass: MEDIUM_RECEIPT_CONFIDENCE,
  persistent_failure: MEDIUM_RECEIPT_CONFIDENCE,
  post_only: MEDIUM_RECEIPT_CONFIDENCE,
  baseline_only: MEDIUM_RECEIPT_CONFIDENCE,
  // The change passed; the baseline that would discriminate never ran.
  infrastructure_unavailable: MEDIUM_RECEIPT_CONFIDENCE,
  // Nothing comparable ran on either side: capped, and a high floor stands.
  indeterminate: Object.freeze({ ceiling: "medium", high_floor: "high" }),
  fixed: null,
  regression: null,
  changed_failure: null,
  out_of_scope_failure: null,
});

// Verification plan obligations, coverage, and failure-fingerprint inputs.

// Coverage statuses that never establish which cases ran: the output had no
// count, the runner reported none, or it stopped before a result.
export const UNESTABLISHED_COVERAGE_STATUSES = Object.freeze(["unknown", "none_executed", "aborted_or_unknown"]);

// Repository verification obligations. Only checks committed in
// posse.verification.json are obligations; package scripts are a legacy
// fallback for a job with no planner selection, limited to these names in
// preference order. Deployment, publish, umbrella (`*:all`), lint, and
// typecheck scripts are never inferred: changed-file checks cover lint and
// typecheck, and a registry can name anything else explicitly.
export const PACKAGE_MANIFEST_FALLBACK_SCRIPTS = Object.freeze(["test", "test:unit", "test:fast", "test:quick"]);
// The check standing in for a committed registry that cannot run. It joins
// the planner's own check as an unavailable obligation; it never rejects it.
export const REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID = "repository:verification_plan";

// Runner output that changes from run to run without changing what failed:
// timings, clocks and memory readings in standard summaries. Failure
// fingerprints replace each match, line by line, after ANSI and line-ending
// normalization. Applied in order.
export const VOLATILE_TEST_OUTPUT_PATTERNS = Object.freeze([
  // Node test runner: `✔ name (1.2ms)` and `ℹ duration_ms 52.1`.
  [/^([✔✖▶].*) \(\d+(?:\.\d+)?ms\)$/gm, "$1 (<duration>)"],
  [/^((?:ℹ|#) duration_ms) \d+(?:\.\d+)?$/gm, "$1 <duration>"],
  // Python unittest: `Ran 3 tests in 0.004s`.
  [/^(Ran \d+ tests? in) \d+(?:\.\d+)?s$/gm, "$1 <duration>"],
  // pytest: `===== 1 failed, 2 passed in 0.03s (0:00:00) =====`; the rule
  // width follows the duration's length.
  [/^=+ (.*?) in \d+(?:\.\d+)?s(?: \(\d+:\d{2}:\d{2}\))? =+$/gm, "== $1 in <duration> =="],
  // Jest `Time:        0.512 s, estimated 1 s`; PHPUnit `Time: 00:00.012, Memory: 6.00 MB`.
  [/^(Time:)\s.*$/gm, "$1 <duration>"],
  // Yarn and other package managers: `✨  Done in 1.20s.`
  [/^(.*\bDone in) \d+(?:\.\d+)?m?s\.?$/gm, "$1 <duration>"],
  // Mocha `1 passing (4ms)`, slow-test suffixes, and Go `--- FAIL: TestX (0.00s)`.
  [/^(.*\S) \(\d+(?:\.\d+)?m?s\)$/gm, "$1 (<duration>)"],
  // Vitest summaries and per-file timings.
  [/^(\s*(?:Duration|Start at))\s.*$/gm, "$1 <duration>"],
  [/^(\s*[✓✗×❯↓] .*?)\s+\d+(?:\.\d+)?m?s$/gm, "$1 <duration>"],
  // Go package lines: `ok  \tpkg\t0.003s`, `FAIL\tpkg\t0.012s`.
  [/^((?:ok|FAIL)\s+\S+)\t\d+(?:\.\d+)?s\b/gm, "$1\t<duration>"],
  // RSpec: `Finished in 0.01 seconds (files took 0.1 seconds to load)`.
  [/^(Finished in)\s.*$/gm, "$1 <duration>"],
]);

// Disposable verification checkouts are `mkdtemp` directories in the system
// temporary directory with these name prefixes (posse-merge-check-XXXXXX,
// posse-closeout-XXXXXX, ...), sometimes with the checkout in one of these
// subdirectories. Their paths differ on every run, so failure fingerprints
// strip them as they strip worktree paths.
export const VOLATILE_CHECKOUT_DIR_PREFIXES = Object.freeze(["posse-merge-check-", "posse-closeout-", BASELINE_CHECKOUT_PREFIX]);
export const VOLATILE_CHECKOUT_SUBDIRS = Object.freeze(["candidate"]);

// Bounds on hashing a dirty worktree's content into a receipt identity. A
// larger dirty set is recorded as dirty_input_fingerprint_unavailable.
export const DIRTY_INPUT_FINGERPRINT_LIMITS = Object.freeze({ max_files: 2_000, max_bytes: 256 * 1024 * 1024 });
// Ignored environment files a test run reads without changing Git status.
// Their digest is part of every receipt identity.
export const VERIFICATION_ENVIRONMENT_FILES = Object.freeze([".env", ".env.test", ".env.testing", ".env.local", ".env.test.local"]);

// Unit-test discovery: a directory named test, tests, or either followed by
// a separator (tests-e2e, test_utils), never testdata or testimonials. Helper
// directories inside a test tree hold no test files of their own.
export const TEST_DIRECTORY_NAME_PATTERN = /^tests?(?:[-_.].*)?$/i;
export const TEST_HELPER_DIRECTORIES = Object.freeze([
  "support", "helpers", "fixtures", "__fixtures__", "testdata", "mocks", "__mocks__", "stubs", "snapshots", "__snapshots__",
]);

// Frozen receipt compatibility, reuse eligibility, and compact evidence bounds.
export const TEST_EXECUTION_RECEIPT_SCHEMA_VERSION = 1;
export const TEST_RECEIPT_MAX_EVIDENCE_OUTPUT_CHARS = 1600;
// Timeouts are not reusable; a completed pass/fail is still subject to the
// receipt consumer's policy, toolchain, tree, and environment identity checks.
export const REUSABLE_RECEIPT_STATUSES = readonlySet(["passed", "failed"]);
export const SCOPE_ATTRIBUTABLE_DELTAS = readonlySet([
  "changed_failure",
  "regression",
  "post_only",
  "persistent_failure",
  "infrastructure_unavailable",
]);

// Shared by setting options and lock-backed dependency repair.
export const VERIFICATION_DEPENDENCY_NETWORK_POLICIES = Object.freeze(["cache_only", "allow", "disabled"]);
