import { MERGE_FAILURE_KINDS } from "../../../catalog/human-input.js";
import { MERGE_GATE_STORED_OUTPUT_CHARS, MERGE_GATE_STORED_RESULTS } from "../../../catalog/verification.js";

/** The last `limit` characters of a check's output: where failures report. */
export function mergeGateOutputTail(value, limit = MERGE_GATE_STORED_OUTPUT_CHARS) {
  if (value == null) return value;
  const text = String(value);
  return text.length > limit ? `[truncated ${text.length - limit} chars] ${text.slice(-limit)}` : text;
}

function boundResult(result = {}) {
  const failure = result.failure && typeof result.failure === "object"
    ? {
      ...Object.fromEntries(["exit_code", "signal", "timed_out", "error_code", "workspace_mutation"]
        .filter((key) => result.failure[key] !== undefined).map((key) => [key, result.failure[key]])),
      message: mergeGateOutputTail(result.failure.message),
    }
    : result.failure;
  return {
    ...Object.fromEntries(["ok", "passed", "status", "test", "failure_kind", "exit_code", "signal", "cwd_relative",
      "run_id", "timeout_ms", "target_debt_classification", "summary"]
      .filter((key) => result[key] !== undefined).map((key) => [key, result[key]])),
    ...(result.stdout !== undefined ? { stdout: mergeGateOutputTail(result.stdout) } : {}),
    ...(result.stderr !== undefined ? { stderr: mergeGateOutputTail(result.stderr) } : {}),
    ...(result.note !== undefined ? { note: mergeGateOutputTail(result.note) } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

/**
 * Bound gate evidence for storage (recovery gate payload, events). Applied
 * after classification, which fingerprints the full output. Keeps what the
 * test waiver (merge-test-waiver.js) and push warnings (workflow-push.js)
 * read: each result's status, check identity, failure kind and target
 * classification, plus the candidate tree and target head. Failed results
 * are kept ahead of passing ones when the result count is capped.
 */
export function boundMergeGateEvidence(gate) {
  if (!gate || typeof gate !== "object") return gate;
  const results = Array.isArray(gate.results) ? gate.results : [];
  const ordered = [...results.filter((result) => result?.ok !== true), ...results.filter((result) => result?.ok === true)];
  return {
    ...gate,
    summary: mergeGateOutputTail(gate.summary),
    results: ordered.slice(0, MERGE_GATE_STORED_RESULTS).map(boundResult),
    ...(ordered.length > MERGE_GATE_STORED_RESULTS ? { results_truncated: ordered.length - MERGE_GATE_STORED_RESULTS } : {}),
  };
}

/** The same failure identity is recorded regardless of who attempted a merge. */
export function mergeFailureDiagnostics(result = {}, { targetBranch = null } = {}) {
  const integrationGate = boundMergeGateEvidence(result?.integrationGate || null);
  const reason = String(result?.reason || "");
  const failureKind = result?.integrationGateFailed || integrationGate?.ok === false
    ? MERGE_FAILURE_KINDS.INTEGRATION_TEST
    : result?.timedOut ? MERGE_FAILURE_KINDS.TIMEOUT
      : reason === "branch_missing" ? MERGE_FAILURE_KINDS.BRANCH_MISSING
        : result?.runtimePathBlocked || /runtime.?path|reserved.?path/i.test(reason) ? MERGE_FAILURE_KINDS.RUNTIME_PATH
          : (result?.deterministicConflict || result?.conflictFiles?.length || /conflict/i.test(reason)) ? MERGE_FAILURE_KINDS.CONFLICT
            : MERGE_FAILURE_KINDS.UNKNOWN;
  return {
    failureKind,
    targetBranch: targetBranch || result?.targetBranch || null,
    targetHead: integrationGate?.target_head || result?.targetHead || null,
    integrationGate,
    message: String(result?.message || (failureKind === MERGE_FAILURE_KINDS.INTEGRATION_TEST
      ? "Merge candidate checks failed" : "Git could not merge the work-item branch")).slice(0, 1000),
  };
}
