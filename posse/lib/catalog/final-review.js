// @ts-check
//
// final_review: the dev/fix close-out step. The agent calls it when its change
// is complete; Posse runs the task's declared tests on the current workspace,
// then a read-only reviewer judges the change against the task contract. An
// accepted pass saves completion and ends both sessions without another tool
// turn. Findings return to the developer; the reviewer waits in the tool so a
// later review continues it with only the diff since its report. A COMPLETE handoff waits
// for a passing review, unless the review could not run within its bounded
// retries, the reviewer could not judge it, or the attempt's reviews are used
// up (domains/assessment, final review).

export const FINAL_REVIEW_TOOL_NAME = "final_review";

// Repository setting: "on" (default) issues the tool to dev/fix agents whose
// remote policy supports it; "off" never issues it.
export const FINAL_REVIEW_SETTING_KEY = "final_review_mode";
export const FINAL_REVIEW_MODES = Object.freeze(["on", "off"]);
export const FINAL_REVIEW_DEFAULT_MODE = "on";

// Reviews per implementation attempt. An unchanged resubmission reuses the
// existing findings without spending a review. Once spent, handoff proceeds and
// the persisted review remains unresolved; no second assessor is dispatched.
export const FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT = 3;
// Even changing diagnostics or distinct failures cannot keep deterministic
// verification in the developer session forever. Exhaustion is not approval.
export const FINAL_REVIEW_MAX_DETERMINISTIC_ROUNDS = 3;
export const FINAL_REVIEW_MAX_UNCHANGED_DETERMINISTIC_ROUNDS = 2;
export const FINAL_REVIEW_CONTINUATION_NEXT_ACTION = "verify_preserved_candidate";

// How a recorded final review reached its result. Only a reviewer's verdict
// (fresh or revision) spends one of the attempt's reviews. Proven
// deterministic findings, reused findings for an unchanged candidate, and a
// review that obtained no reviewer verdict (provider error, a reviewer that
// ended without reporting on its revision, the reviewer's wall) are free.
export const FINAL_REVIEW_REVIEW_MODES = Object.freeze({
  FRESH: "fresh",
  REVISION: "revision",
  DETERMINISTIC: "deterministic",
  UNCHANGED: "unchanged",
  INFRASTRUCTURE: "infrastructure",
});
export const FINAL_REVIEW_UNCHARGED_REVIEW_MODES = Object.freeze([
  FINAL_REVIEW_REVIEW_MODES.DETERMINISTIC,
  FINAL_REVIEW_REVIEW_MODES.UNCHANGED,
  FINAL_REVIEW_REVIEW_MODES.INFRASTRUCTURE,
]);
// Infrastructure rounds per attempt the handoff waits on: while they remain,
// the developer is told to call final_review again; after them the handoff
// proceeds and the ordinary assessment verifies the change.
export const FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS = 2;
// Allow one correction of a malformed report, then release the reviewer into
// the bounded infrastructure recovery path instead of spending turns forever.
export const FINAL_REVIEW_MAX_INVALID_REPORTS = 2;

// Whole tool call: the declared tests plus the reviewer's own agent call. The
// owner's progress heartbeat keeps the transport alive meanwhile; this is the
// provider client's per-call deadline (catalog/mcp.js).
export const FINAL_REVIEW_TIMEOUT_MS = 40 * 60 * 1000;
export const FINAL_REVIEW_TEST_TIMEOUT_MS = 15 * 60 * 1000;
// The reviewer's floor within one round. Each stage before it (declared
// tests, changed tests, changed-file checks) is capped at
// FINAL_REVIEW_TEST_TIMEOUT_MS and at what remains of the round above this
// floor, so three slow stages cannot leave the reviewer no time to report. A
// stage the remaining budget cannot fund ends the round as infrastructure
// instead of running into the wall.
export const FINAL_REVIEW_REVIEWER_MIN_ROUND_MS = 10 * 60 * 1000;

// Before the reviewer starts, final_review also runs the changed-file checks
// the assessment harness runs after handoff and the unit test files the
// change adds or edits, so their failures reach the developer in the same
// attempt (domains/assessment/functions/final-review-checks.js).
export const FINAL_REVIEW_CHECKS = Object.freeze(["lint", "typecheck"]);
export const FINAL_REVIEW_CHECK_MAX_FILES = 250;

// Only a failure attributable to the change in process is a finding without
// the reviewer: a check failure on a line the change added, or a failing
// test file the change added that its runner ran on its own (a
// repository script runs one shared suite for every file it covers). Every
// other failure may predate the change; the reviewer judges it as evidence.
// The labels head each attribution in the reviewer's evidence.
export const FINAL_REVIEW_CHECK_ATTRIBUTION_LABELS = Object.freeze({
  introduced: "On lines this change added (defects in this change):",
  inChanged: "Elsewhere in the changed files (may predate this change; judge whether the change caused it):",
  elsewhere: "Elsewhere in the project (may predate this change; a caller this change broke is still its defect):",
});
export const FINAL_REVIEW_PROVEN_TEST_STATUSES = Object.freeze(["failed"]);
export const FINAL_REVIEW_SHARED_TEST_RUNNERS = Object.freeze(["repository_script"]);

export const FINAL_REVIEW_CONTRACT_FIELDS = Object.freeze([
  "task_spec", "instructions", "root_task_spec", "original_task_spec", "fix_instructions",
  "success_criteria", "root_success_criteria", "constraints", "test_command", "tests_to_run", "verification_contract",
  "files_to_modify", "files_to_create", "files_to_delete", "create_roots",
]);

// The reviewer gets the scoped diff inline up to this size, plus the full
// changed-file list; it reads whatever does not fit with its read tools.
export const FINAL_REVIEW_DIFF_INLINE_MAX_CHARS = 60_000;
export const FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS = 6_000;
export const FINAL_REVIEW_MAX_FINDINGS = 12;
// A re-review sees only what changed since the reviewer's last report.
export const FINAL_REVIEW_DELTA_INLINE_MAX_CHARS = 30_000;

// The reviewer reports with the same tool and waits in it for the developer's
// next revision; these are what its waiting call returns.
export const FINAL_REVIEW_VERDICTS = Object.freeze(["pass", "fail", "needs_review"]);
export const FINAL_REVIEW_REVIEWER_STATUS = Object.freeze({
  REVISED: "revised",
  WAITING: "waiting",
  DONE: "done",
});
export const FINAL_REVIEW_REVIEWER_PARK_MS = 35 * 60_000;
export const FINAL_REVIEW_REVIEWER_WALL_MS = 55 * 60_000;
// A parked reviewer with less of its wall left than this cannot judge a
// revision; it is released and the revision goes to a fresh reviewer.
export const FINAL_REVIEW_REVISION_MIN_REMAINING_MS = 10 * 60_000;

export const FINAL_REVIEW_OUTCOMES = Object.freeze({
  PASS: "pass",
  FINDINGS: "findings",
  // The review could not reach a verdict on the work (infrastructure, an
  // unresolvable contract question). It never holds the handoff.
  BLOCKED: "blocked",
});

export const FINAL_REVIEW_OBSERVATIONS = Object.freeze({
  // The agent call was issued the tool; the handoff gate applies to it.
  ISSUED: "final_review.issued",
  RESULT: "final_review.result",
  SOURCE_READS: "review.source_reads",
});

export const FINAL_REVIEW_CHILD_KIND = "final_review";

export const FINAL_REVIEW_SOURCE_READ_TYPES = Object.freeze(["tool.read", "tool.chain_read", "tool.read.not_found"]);
export const FINAL_REVIEW_SOURCE_READ_ACTIONS = Object.freeze(["symbol.get", "fetch_ref", "code.window", "code.lens", "code.skeleton"]);
