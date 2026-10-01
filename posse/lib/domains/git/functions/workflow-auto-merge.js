// lib/domains/git/functions/workflow-auto-merge.js
// End-of-run auto-merge orchestration.

import {
  activeWorkItemDispositionGates,
  authorizeWorkItemAutoMerge,
  listCrossWiMergeBlockers,
  listWorkItems,
  logEvent,
  markWorkItemMergeFailed,
  mergeVerificationReviewHoldsAutoMerge,
  orderWorkItemsByMergeDependencies,
  pendingCrossWiMergeUpstreamIds,
  releaseWorkItemAutoMergeAuthorization,
  refreshWorkItemStatuses,
  setMergeState,
} from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { gcWorktreesAsync } from "./worktree.js";
import { sortWorkItemsByCompletion } from "./merge-closeout.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE } from "../../../catalog/human-input.js";

const AUTO_MERGE_STATUS_RECONCILE_STATUSES = [
  "queued",
  "planning",
  "planned",
  "running",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
];

// Merge results carry a message, or at least a reason code; never print "undefined".
function mergeResultText(result, fallback) {
  const message = String(result?.message || "").trim();
  if (message) return message;
  const reason = String(result?.reason || "").trim();
  return reason ? `${fallback} (${reason.replaceAll("_", " ")})` : fallback;
}

export function createAutoMergeWorkflowHelpers(context, {
  gitMergeToTargetAsync,
  queueAtlasMainRefreshAfterMerge,
  cleanupWiBranchAsync,
  snapshotAndRemoveWorktreeOnlyAsync,
}) {
  const {
    projectDir,
    autoMerge,
    currentTargetBranch,
    isIterativeWorkItemActive,
    shouldAutoApproveIterativeWorkItem,
  } = context;
  const mergeBlockersForWorkItem = context.listCrossWiMergeBlockers || listCrossWiMergeBlockers;

  // Close-out order: cross-WI sources before their dependents, otherwise in
  // completion order, merged one at a time so each refresh sees the target
  // its predecessors produced. A work item whose merge waits on an operator
  // verification review stays out until that review passes. A dependent whose
  // upstream is still in flight and not merging ahead of it in this pass is
  // left out: it could only be authorized, deferred and released again on
  // every pass (NEW-L1). So is one whose operator is deciding what to do about
  // a failed upstream: authorization refuses it while that gate is open. An
  // upstream that failed or was canceled never merges in this pass either, so
  // its dependent stays out quietly after the gate was answered "wait" too.
  function listEndOfRunMergeableWorkItems() {
    const ordered = orderWorkItemsByMergeDependencies(sortWorkItemsByCompletion(
      listWorkItems(["complete"])
        .filter(wi => wi.branch_name && wi.merge_state !== "merged")
        .filter((wi) => !isIterativeWorkItemActive(wi))
        .filter((wi) => autoMerge || shouldAutoApproveIterativeWorkItem(wi))
        .filter((wi) => !mergeVerificationReviewHoldsAutoMerge(wi.id))
        .filter((wi) => activeWorkItemDispositionGates(wi.id, CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE).length === 0),
    ));
    const listedIds = new Set();
    return ordered.filter((wi) => {
      if (pendingCrossWiMergeUpstreamIds(wi, { includeStale: true }).some((id) => !listedIds.has(id))) return false;
      listedIds.add(Number(wi.id));
      return true;
    });
  }

  function hasAutoMergeableCompletedWorkItems() {
    // A completed WI whose only path to the target is blocked by another WI
    // is reviewable, but it is not presently auto-mergeable. Reporting it as
    // mergeable makes every scheduler idle/job-completion cycle retry the same
    // deterministic deferral. Once its upstream merges, the blocker query
    // becomes empty and the candidate is eligible again.
    return listEndOfRunMergeableWorkItems().some((wi) => {
      try {
        return mergeBlockersForWorkItem(wi.id).length === 0;
      } catch {
        // Preserve the older fail-open behavior if blocker inspection itself
        // fails; the guarded merge path will still refuse an unsafe merge.
        return true;
      }
    });
  }

  let autoMergeCompletedWorkItemsPromise = null;

  async function autoMergeCompletedWorkItemsImpl({
    display = null,
    reason = "run wrap-up",
    runGc = true,
    mergeLockAlreadyHeld = false,
  } = {}) {
    refreshWorkItemStatuses(AUTO_MERGE_STATUS_RECONCILE_STATUSES);
    const mergeable = listEndOfRunMergeableWorkItems();

    const say = (message) => {
      if (display) display.addEvent(message);
      else console.log(message);
    };
    const updateStep = (id, status, detail = "") => {
      try { display?.updateWrapUpOverlayStep?.(id, { status, detail }); } catch { /* display callback only */ }
    };

    if (mergeable.length > 0) {
      if (typeof display?.setRunPhase === "function") {
        display.setRunPhase(`Auto-merging ${mergeable.length} completed work item branch${mergeable.length === 1 ? "" : "es"}`);
      }
      say(`  ${C.cyan}[git]${C.reset} Auto-merging ${mergeable.length} completed work item branch(es) at ${reason}`);
    }

    let mergedCount = 0;
    const deferredWorkItemIds = new Set();
    const failedWorkItemIds = new Set();
    let pendingMergeable = mergeable;
    let mergePass = 0;
    while (pendingMergeable.length > 0) {
      mergePass += 1;
      let mergedThisPass = 0;
      const deferredIds = new Set();
      for (const wi of pendingMergeable) {
        const targetBranch = currentTargetBranch();
        const authorization = authorizeWorkItemAutoMerge(wi.id, { expectedBranch: wi.branch_name });
        if (!authorization.ok && authorization.reason === "verification_review_required") {
          // Not a stale candidate: the authorization opened (and logged) a review gate.
          say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: planned verification was waived (baseline debt); merge waits for operator review (gate #${authorization.gate_job_id})`);
          continue;
        }
        // An upstream listed ahead of it did not merge this pass; nothing
        // changed for this candidate, so skip it without events.
        if (!authorization.ok && authorization.reason === "upstream_merge_pending") continue;
        if (!authorization.ok) {
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_CANDIDATE_INVALIDATED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Skipped stale automatic merge candidate: ${authorization.reason}`,
            event_json: JSON.stringify({ reason: authorization.reason, expected_branch: wi.branch_name }),
          });
          say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: merge candidate changed (${authorization.reason}); skipped`);
          continue;
        }
        const branchName = authorization.branch;
        if (typeof display?.setRunPhase === "function") {
          display.setRunPhase(`Merging WI#${wi.id} into ${targetBranch}`);
        }
        updateStep("merge", "running", `WI#${wi.id} -> ${targetBranch}`);
        let result;
        try {
          result = await gitMergeToTargetAsync(branchName, projectDir, {
            wiId: wi.id,
            mergeLockAlreadyHeld,
            onPhase(event = {}) {
              if (event.phase === "commit") {
                if (typeof display?.setRunPhase === "function") display.setRunPhase(`Committing WI#${wi.id} squash merge`);
              } else if (event.phase === "retry") {
                updateStep("merge", "running", `retrying WI#${wi.id}`);
                if (typeof display?.setRunPhase === "function") display.setRunPhase(`Retrying merge for WI#${wi.id}`);
                say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: retrying merge`);
              } else if (event.phase === "merge") {
                updateStep("merge", "running", `WI#${wi.id} -> ${targetBranch}`);
                if (typeof display?.setRunPhase === "function") display.setRunPhase(`Merging WI#${wi.id} into ${targetBranch}`);
              }
            },
          });
        } catch (err) {
          releaseWorkItemAutoMergeAuthorization(wi.id, authorization.previousMergeState);
          throw err;
        }
        if (result.ok) {
          deferredWorkItemIds.delete(wi.id);
          failedWorkItemIds.delete(wi.id);
          const mergeHash = result.mergeHash || "(unknown)";
          const autoApproveReason = shouldAutoApproveIterativeWorkItem(wi) && !autoMerge ? "iterate_auto_merge" : "auto_merge";
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: "Auto-approved for end-of-run merge",
            event_json: JSON.stringify({ approval_type: autoApproveReason, reason }),
          });
          if (!result.sharedTrunk) {
            logEvent({
              work_item_id: wi.id,
              event_type: EVENT_TYPES.WORK_ITEM_MERGED,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Auto-merged ${branchName} into ${targetBranch} at ${mergeHash}`,
              event_json: JSON.stringify({ branch: branchName, merge_hash: mergeHash, target_branch: targetBranch, reason }),
            });
          }
          setMergeState(wi.id, "merged");
          updateStep("merge", "done", `${targetBranch} ${mergeHash.slice(0, 8)}`);
          // ATLAS reindex is never a blocking step on the review/approval or
          // wrap-up path: enqueue the merge replay on the background warm
          // scheduler and move on. The queued job survives WI cleanup (only
          // purpose "wi" warms are retired) and session exit.
          let atlasFollowupOk = true;
          if (result.sharedTrunk) {
            updateStep("atlas", "done", "queued after publication");
            updateStep("onnx", "skipped", "runs with background replay");
          } else try {
            const queued = queueAtlasMainRefreshAfterMerge({
              wiId: wi.id,
              branchName,
              targetBranch,
              mergeHash,
            });
            if (queued.ok === false) {
              atlasFollowupOk = false;
              updateStep("atlas", "failed", "background replay enqueue failed");
              say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ATLAS merge replay enqueue failed after merge`);
            } else if (queued.attempted === false) {
              updateStep("atlas", "skipped", "ATLAS off");
              updateStep("onnx", "skipped", "ATLAS off");
            } else {
              updateStep("atlas", "done", queued.coalesced ? "queued in background (coalesced)" : "queued in background");
              updateStep("onnx", "skipped", "runs with background replay");
              if (!display) say(`  ${C.dim}[git]${C.reset} WI#${wi.id}: ATLAS main replay queued in background`);
            }
          } catch (err) {
            atlasFollowupOk = false;
            updateStep("atlas", "failed", err?.message || String(err));
            say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ATLAS merge replay enqueue failed after merge: ${err?.message || err}`);
          }
          let cleanupOk = false;
          try {
            updateStep("cleanup", "running", `WI#${wi.id}`);
            cleanupOk = await cleanupWiBranchAsync(wi);
            updateStep("cleanup", cleanupOk ? "done" : "failed", cleanupOk ? `WI#${wi.id}` : "branch cleanup failed");
          } catch (err) {
            updateStep("cleanup", "failed", err?.message || String(err));
            say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: branch cleanup failed after merge: ${err?.message || err}`);
          }
          const postMergeSuffix = cleanupOk && atlasFollowupOk
            ? ""
            : ` ${C.yellow}(post-merge follow-up needs attention)${C.reset}`;
          say(`  ${C.green}[git]${C.reset} WI#${wi.id}: merged ${branchName} (${mergeHash.slice(0, 8)})${postMergeSuffix}`);
          if (typeof display?.setRunPhase === "function") {
            display.setRunPhase(`Merged WI#${wi.id}`);
          }
          mergedCount++;
          mergedThisPass++;
        } else if (result.deferred) {
          releaseWorkItemAutoMergeAuthorization(wi.id, authorization.previousMergeState);
          deferredIds.add(wi.id);
          deferredWorkItemIds.add(wi.id);
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_DEFERRED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: mergeResultText(result, "merge deferred"),
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ${mergeResultText(result, "merge deferred")}`);
          updateStep("merge", "skipped", `WI#${wi.id} deferred for review`);
          if (typeof display?.setRunPhase === "function") {
            display.setRunPhase(`Merge deferred for WI#${wi.id}; review required`);
          }
        } else {
          failedWorkItemIds.add(wi.id);
          markWorkItemMergeFailed(wi.id);
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_FAILED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Auto-merge failed for ${branchName}: ${mergeResultText(result, "merge failed")}`,
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          // Jobs are done; the worktree is no longer useful. Snapshot any dirt and
          // remove the directory, but keep the branch so a manual retry is possible.
          await snapshotAndRemoveWorktreeOnlyAsync(wi, "merge-failed");
          say(`  ${C.red}[git]${C.reset} WI#${wi.id}: ${mergeResultText(result, "merge failed")}`);
          updateStep("merge", "failed", `WI#${wi.id} merge failed; review required`);
        }
      }
      if (deferredIds.size === 0 || mergedThisPass === 0) break;
      pendingMergeable = listEndOfRunMergeableWorkItems()
        .filter((wi) => deferredIds.has(wi.id));
      if (pendingMergeable.length > 0) {
        say(`  ${C.cyan}[git]${C.reset} Retrying ${pendingMergeable.length} deferred work item merge(s) after upstream progress`);
      }
      if (mergePass >= mergeable.length + 1) break;
    }

    // A later candidate or retry can overwrite the shared merge row. Restore
    // the terminal aggregate state so a legitimate dependency deferral never
    // leaves the wrap-up screen displaying an active merge spinner.
    if (failedWorkItemIds.size > 0) {
      const deferredDetail = deferredWorkItemIds.size > 0
        ? `; ${deferredWorkItemIds.size} deferred for review`
        : "";
      updateStep("merge", "failed", `${failedWorkItemIds.size} failed${deferredDetail}`);
    } else if (deferredWorkItemIds.size > 0) {
      const deferredCount = deferredWorkItemIds.size;
      const mergedDetail = mergedCount > 0 ? `; ${mergedCount} merged` : "";
      updateStep("merge", "skipped", `${deferredCount} deferred for review${mergedDetail}`);
    }

    // End-of-wrap-up safety net: reap any worktrees for WIs that went terminal
    // during the run but weren't eligible for auto-merge (e.g. status=failed,
    // canceled, or complete-but-pending-review). Mirrors boot GC semantics —
    // snapshots dirty state before removing, preserves worktrees for WIs that
    // still hold a bench (active jobs or pending human input).
    if (runGc) {
      try {
        if (typeof display?.setRunPhase === "function") {
          display.setRunPhase(mergedCount > 0 ? "Checking merged worktrees" : "Checking completed worktrees");
        }
        await gcWorktreesAsync(projectDir, (msg) => say(`  ${C.dim}[gc]${C.reset} ${msg}`));
      } catch (err) {
        say(`  ${C.yellow}[gc]${C.reset} worktree sweep failed: ${err?.message || err}`);
      }
    }

    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(mergedCount > 0
        ? `${mergedCount} work item${mergedCount === 1 ? "" : "s"} merged; preparing push prompt`
        : "Wrap-up complete");
    }

    return mergedCount;
  }

  async function autoMergeCompletedWorkItems(args = {}) {
    const prior = autoMergeCompletedWorkItemsPromise;
    const queued = (prior || Promise.resolve())
      .catch(() => {})
      .then(() => autoMergeCompletedWorkItemsImpl(args).catch((err) => {
        // Auto-merge is best-effort run wrap-up. A native-git/heartbeat failure
        // here (e.g. resolveTargetBranch during the merge loop) must NOT escape
        // as an unhandledRejection — that exits the orchestrator and aborts the
        // whole wrap-up. Log and report zero merges; nothing already committed
        // is lost, and the WIs stay mergeable for the next wrap-up / review.
        try {
          console.log(`  ${C.yellow}[git]${C.reset} Auto-merge skipped (wrap-up error): ${err?.message || err}`);
        } catch { /* best effort: never let logging crash wrap-up */ }
        return 0;
      }));
    const tracked = queued.finally(() => {
      if (autoMergeCompletedWorkItemsPromise === tracked) {
        autoMergeCompletedWorkItemsPromise = null;
      }
    });
    autoMergeCompletedWorkItemsPromise = tracked;
    return queued;
  }


  return {
    listEndOfRunMergeableWorkItems,
    hasAutoMergeableCompletedWorkItems,
    autoMergeCompletedWorkItems,
  };
}
