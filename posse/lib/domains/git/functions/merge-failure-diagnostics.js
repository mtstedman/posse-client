import { MERGE_FAILURE_KINDS } from "../../../catalog/human-input.js";

/** The same failure identity is recorded regardless of who attempted a merge. */
export function mergeFailureDiagnostics(result = {}, { targetBranch = null } = {}) {
  const integrationGate = result?.integrationGate || null;
  const reason = String(result?.reason || "");
  const failureKind = result?.integrationGateFailed || integrationGate?.ok === false
    ? MERGE_FAILURE_KINDS.INTEGRATION_TEST
    : result?.timedOut ? MERGE_FAILURE_KINDS.TIMEOUT
      : reason === "branch_missing" ? MERGE_FAILURE_KINDS.BRANCH_MISSING
        : /runtime.?path|reserved.?path/i.test(reason) ? MERGE_FAILURE_KINDS.RUNTIME_PATH
          : (result?.conflictFiles?.length || /conflict/i.test(reason)) ? MERGE_FAILURE_KINDS.CONFLICT
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
