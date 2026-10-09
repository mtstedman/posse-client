// The operator's "merge it now" from inside a gate on the work item (a merge
// recovery answer): the locked merge `posse merge` performs, honoring a
// recorded deterministic conflict the operator chose to retry. Unlike the
// bridge approval it does not settle the work item's review rows, which
// would retire the very gate whose answer is running; that gate completes
// itself. A merge that fails again marks the work item merge_failed, which
// reuses the gate while it is still resolving.

import {
  getWorkItem,
  logEvent,
  markWorkItemMergeFailed,
  setMergeState,
} from "../../queue/functions/index.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { createGitWorkflowHelpers } from "./workflows.js";
import { resolveTargetBranchForAdmin } from "./target-branch.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";

/**
 * @param {number} workItemId
 * @param {{ projectDir: string, actor?: string, workflow?: any, testWaiver?: any }} options
 * @returns {Promise<{ ok: boolean, merge_hash?: string | null, already_merged?: boolean, reason?: string, message?: string }>}
 */
export async function mergeWorkItemNow(workItemId, { projectDir, actor = "operator", workflow = null, testWaiver = null } = /** @type {any} */ ({})) {
  const targetBranch = resolveTargetBranchForAdmin(projectDir);
  const helpers = workflow || createGitWorkflowHelpers({ projectDir, targetBranch, nonInteractive: true });
  const outcome = await withMergeLock(async () => {
    const workItem = getWorkItem(workItemId);
    if (!workItem) return { ok: false, reason: "no_such_wi", message: "The work item no longer exists" };
    if (workItem.merge_state === "merged") return { ok: true, alreadyMerged: true };
    if (!workItem.branch_name) {
      markWorkItemMergeFailed(workItemId, { message: "The work-item branch is no longer available", targetBranch });
      return { ok: false, reason: "branch_missing", message: "The work-item branch is no longer available" };
    }
    const result = await helpers.gitMergeToTargetAsync(workItem.branch_name, projectDir, {
      wiId: workItemId,
      retryDeterministicConflict: true,
      mergeLockAlreadyHeld: true,
      testWaiver,
    });
    if (result?.ok) setMergeState(workItemId, "merged");
    else if (!result?.deferred) markWorkItemMergeFailed(workItemId, { message: result?.message || null, targetBranch, integrationGate: result?.integrationGate || null });
    return { ...result, branchName: workItem.branch_name };
  });
  if (!outcome.acquired) {
    return { ok: false, reason: "merge_in_progress", message: "Another merge is in progress; answer again when it finishes" };
  }
  const result = outcome.result || {};
  if (result.alreadyMerged) return { ok: true, already_merged: true, merge_hash: null };
  if (!result.ok) {
    return { ok: false, reason: result.deferred ? "merge_deferred" : "merge_failed", message: result.message || "Git could not merge the work-item branch" };
  }
  const mergeHash = result.mergeHash || null;
  logEvent({
    work_item_id: workItemId,
    event_type: EVENT_TYPES.WORK_ITEM_MERGED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: `Merged ${result.branchName} into ${targetBranch} at ${mergeHash || "(unknown)"}`,
    event_json: JSON.stringify({ branch: result.branchName, merge_hash: mergeHash, target_branch: targetBranch }),
  });
  // Best effort, like the bridge approval: the merge is already durable.
  void Promise.resolve()
    .then(() => helpers.cleanupWiBranchAsync?.(getWorkItem(workItemId)))
    .catch(() => {});
  void Promise.resolve()
    .then(() => helpers.refreshPushOfferGate?.(1, { createdBy: "merge_recovery_gate" }))
    .catch(() => {});
  return { ok: true, merge_hash: mergeHash };
}
