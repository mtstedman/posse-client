// @ts-check
//
// final_review: the dev/fix close-out step. The agent calls it when its change
// is complete; Posse runs the task's declared tests on the current workspace,
// then a fresh read-only reviewer judges the change against the task contract,
// and the structured result returns to the same agent session. A COMPLETE
// handoff waits for a passing review, unless the review could not run or the
// attempt's reviews are used up (domains/assessment, final review).

export const FINAL_REVIEW_TOOL_NAME = "final_review";

// Repository setting: "on" (default) issues the tool to dev/fix agents whose
// remote policy supports it; "off" never issues it.
export const FINAL_REVIEW_SETTING_KEY = "final_review_mode";
export const FINAL_REVIEW_MODES = Object.freeze(["on", "off"]);
export const FINAL_REVIEW_DEFAULT_MODE = "on";

// Reviews per implementation attempt. Once spent, the handoff proceeds and
// the independent assessment after it decides.
export const FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT = 3;

// Whole tool call: the declared tests plus the reviewer's own agent call. The
// owner's progress heartbeat keeps the transport alive meanwhile; this is the
// provider client's per-call deadline (catalog/mcp.js).
export const FINAL_REVIEW_TIMEOUT_MS = 40 * 60 * 1000;
export const FINAL_REVIEW_TEST_TIMEOUT_MS = 15 * 60 * 1000;

// The reviewer gets the scoped diff inline up to this size, plus the full
// changed-file list; it reads whatever does not fit with its read tools.
export const FINAL_REVIEW_DIFF_INLINE_MAX_CHARS = 60_000;
export const FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS = 6_000;
export const FINAL_REVIEW_MAX_FINDINGS = 12;

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
});

export const FINAL_REVIEW_CHILD_KIND = "final_review";
