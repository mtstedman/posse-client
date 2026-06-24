// lib/domains/git/functions/workflow-auto-merge.js
// End-of-run auto-merge orchestration.

import { listCrossWiMergeBlockers, listWorkItems, logEvent, refreshWorkItemStatuses, setMergeState } from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { gcWorktreesAsync } from "./worktree.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const AUTO_MERGE_STATUS_RECONCILE_STATUSES = [
  "queued",
  "planning",
  "planned",
  "running",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
];

export function createAutoMergeWorkflowHelpers(context, {
  gitMergeToTargetAsync,
  refreshAtlasMainAfterMerge,
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

  function listEndOfRunMergeableWorkItems() {
    return listWorkItems(["complete"])
      .filter(wi => wi.branch_name && wi.merge_state !== "merged")
      .filter((wi) => !isIterativeWorkItemActive(wi))
      .filter((wi) => autoMerge || shouldAutoApproveIterativeWorkItem(wi));
  }

  function hasAutoMergeableCompletedWorkItems() {
    return listEndOfRunMergeableWorkItems()
      .some((wi) => wi.merge_state !== "merge_failed");
  }

  let autoMergeCompletedWorkItemsPromise = null;

  async function autoMergeCompletedWorkItemsImpl({ display = null, reason = "run wrap-up", runGc = true } = {}) {
    refreshWorkItemStatuses(AUTO_MERGE_STATUS_RECONCILE_STATUSES);
    const mergeable = listEndOfRunMergeableWorkItems();

    const say = (message) => {
      if (display) display.addEvent(message);
      else console.log(message);
    };
    const updateStep = (id, status, detail = "") => {
      try { display?.updateWrapUpOverlayStep?.(id, { status, detail }); } catch { /* display callback only */ }
    };
    const exitRequested = () => {
      try { return display?.isWrapUpEarlyExitRequested?.() === true; } catch { return false; }
    };
    const abortError = () => {
      const err = new Error("operator exited wrap-up early");
      err.name = "AbortError";
      try { err.code = "ABORT_ERR"; } catch { /* best effort */ }
      return err;
    };
    const updateAtlasProgress = (event = {}) => {
      const stage = String(event.stage || "").trim();
      const text = String(event.text || stage || "working").trim();
      const pct = Number(event.percent);
      const detail = Number.isFinite(pct) ? `${Math.round(pct)}% ${text}` : text;
      if (stage === "embeddings" || stage === "encoding") {
        updateStep("onnx", "running", detail);
      } else if (stage === "tree" || stage === "tree-compression") {
        updateStep("tree", "running", detail);
      } else {
        updateStep("atlas", "running", detail);
      }
    };

    if (mergeable.length > 0) {
      if (typeof display?.setRunPhase === "function") {
        display.setRunPhase(`Auto-merging ${mergeable.length} completed work item branch${mergeable.length === 1 ? "" : "es"}`);
      }
      say(`  ${C.cyan}[git]${C.reset} Auto-merging ${mergeable.length} completed work item branch(es) at ${reason}`);
    }

    let mergedCount = 0;
    let pendingMergeable = mergeable;
    let mergePass = 0;
    while (pendingMergeable.length > 0) {
      mergePass += 1;
      let mergedThisPass = 0;
      const deferredIds = new Set();
      for (const wi of pendingMergeable) {
        const targetBranch = currentTargetBranch();
        const branchName = wi.branch_name;
        if (typeof display?.setRunPhase === "function") {
          display.setRunPhase(`Merging WI#${wi.id} into ${targetBranch}`);
        }
        updateStep("merge", "running", `WI#${wi.id} -> ${targetBranch}`);
        const result = await gitMergeToTargetAsync(branchName, projectDir, {
          wiId: wi.id,
          onPhase(event = {}) {
            if (event.phase === "atlas-indexing") {
              if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS indexing WI#${wi.id}`);
              if (!display) say(`  ${C.cyan}[git]${C.reset} WI#${wi.id}: ATLAS post-commit indexing`);
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
        if (result.ok) {
          const mergeHash = result.mergeHash || "(unknown)";
          const autoApproveReason = shouldAutoApproveIterativeWorkItem(wi) && !autoMerge ? "iterate_auto_merge" : "auto_merge";
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: "Auto-approved for end-of-run merge",
            event_json: JSON.stringify({ approval_type: autoApproveReason, reason }),
          });
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Auto-merged ${branchName} into ${targetBranch} at ${mergeHash}`,
            event_json: JSON.stringify({ branch: branchName, merge_hash: mergeHash, target_branch: targetBranch, reason }),
          });
          setMergeState(wi.id, "merged");
          updateStep("merge", "done", `${targetBranch} ${mergeHash.slice(0, 8)}`);
          let atlasFollowupOk = true;
          try {
            updateStep("atlas", "running", `WI#${wi.id} main replay`);
            const atlasAbort = new AbortController();
            const abortIfRequested = () => {
              if (!atlasAbort.signal.aborted && exitRequested()) atlasAbort.abort(abortError());
            };
            abortIfRequested();
            let poll = setInterval(abortIfRequested, 250);
            poll.unref?.();
            let replay;
            try {
              replay = await refreshAtlasMainAfterMerge({
                wiId: wi.id,
                branchName,
                targetBranch,
                mergeHash,
                onPhase: (event = {}) => {
                  if (event.phase === "atlas-indexing") {
                    if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS finalizing WI#${wi.id}`);
                    if (!display) say(`  ${C.cyan}[git]${C.reset} WI#${wi.id}: ATLAS final merge indexing`);
                  } else if (event.phase === "atlas-progress") {
                    updateAtlasProgress(event.atlasEvent || {});
                  }
                },
                onProgress: (event = {}) => {
                  updateAtlasProgress(event);
                  abortIfRequested();
                },
                signal: atlasAbort.signal,
                source: "auto_merge",
              });
            } finally {
              if (poll) {
                clearInterval(poll);
                poll = null;
              }
            }
            const warmResult = replay?.result || {};
            if (replay?.aborted) {
              updateStep("atlas", "skipped", "queued for next run");
              updateStep("onnx", "skipped", "queued for next run");
              say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ATLAS finalization deferred; queued for next run`);
            } else {
              updateStep("atlas", "done", `view ${warmResult.paths_indexed ?? warmResult.paths_considered ?? 0} path(s)`);
              if (warmResult.embeddings_deferred === true) updateStep("onnx", "skipped", "queued for next run");
              else if (warmResult.embeddings_indexed != null || warmResult.embeddings_candidates != null) updateStep("onnx", "done", `${warmResult.embeddings_indexed ?? 0}/${warmResult.embeddings_candidates ?? "?"}`);
            }
          } catch (err) {
            atlasFollowupOk = false;
            updateStep("atlas", "failed", err?.message || String(err));
            say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ATLAS finalization failed after merge: ${err?.message || err}`);
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
          deferredIds.add(wi.id);
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_DEFERRED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: result.message,
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ${result.message}`);
        } else {
          setMergeState(wi.id, "merge_failed");
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_FAILED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Auto-merge failed for ${branchName}: ${result.message}`,
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          // Jobs are done; the worktree is no longer useful. Snapshot any dirt and
          // remove the directory, but keep the branch so a manual retry is possible.
          await snapshotAndRemoveWorktreeOnlyAsync(wi, "merge-failed");
          say(`  ${C.red}[git]${C.reset} WI#${wi.id}: ${result.message}`);
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
