// Review, approval, and wrap-up orchestration for CLI sessions.

import { parseJobPayload } from "../../queue/functions/payload.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { jobIsWriteStep } from "../../ui/functions/display/helpers/job-status.js";
import { finalAssessmentFor } from "./review-report.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { FAILED_JOB_STATUSES } from "../../../catalog/job.js";

function createTuiWrapUpTracker(display, { title = "Review closeout", subtitle = "", steps = [] } = {}) {
  const hasOverlay = !!display && typeof display.setWrapUpOverlay === "function";
  const normalizedSteps = (Array.isArray(steps) ? steps : [])
    .map((step, idx) => ({
      id: step.id || `step-${idx}`,
      label: step.label || `Step ${idx + 1}`,
      status: step.status || "pending",
      detail: step.detail || "",
    }));
  if (hasOverlay) {
    display.setWrapUpOverlay({
      title,
      subtitle,
      steps: normalizedSteps,
    });
  }

  const update = (id, status, detail = "") => {
    if (!hasOverlay || !id) return;
    display.updateWrapUpOverlayStep?.(id, { status, detail });
  };

  return {
    start(id, detail = "") {
      update(id, "running", detail);
    },
    done(id, detail = "") {
      update(id, "done", detail);
    },
    skip(id, detail = "") {
      update(id, "skipped", detail);
    },
    fail(id, detail = "") {
      update(id, "failed", detail);
    },
    async run(id, fn, { doneDetail = "" } = {}) {
      this.start(id);
      try {
        const result = await Promise.resolve().then(fn);
        this.done(id, typeof doneDetail === "function" ? doneDetail(result) : doneDetail);
        return result;
      } catch (err) {
        this.fail(id, String(err?.message || err || "failed").slice(0, 80));
        throw err;
      }
    },
    clear() {
      if (hasOverlay) display.clearWrapUpOverlay?.();
    },
  };
}

export async function askSingleKeyChoice(prompt, choices = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  fallbackAsk = null,
} = {}) {
  const allowed = new Set((Array.isArray(choices) ? choices : [])
    .map((choice) => String(choice || "").trim().toLowerCase())
    .filter(Boolean)
    .map((choice) => choice[0]));
  if (!stdin?.isTTY) {
    if (typeof fallbackAsk === "function") return fallbackAsk(prompt);
    stdout.write(prompt);
    return "";
  }

  return new Promise((resolve) => {
    let settled = false;
    const wasRaw = Boolean(stdin.isRaw);
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = () => {
      try { stdin.off("data", onData); } catch { /* best effort */ }
      try { stdin.setRawMode(wasRaw); } catch { /* best effort */ }
      if (wasPaused) {
        try { stdin.pause(); } catch { /* best effort */ }
      }
    };

    const settle = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write(`${answer || ""}\n`);
      resolve(answer);
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!text) return;
      for (const ch of text) {
        const key = ch.toLowerCase();
        if (allowed.has(key)) return settle(key);
        if (key === "\r" || key === "\n" || key === "\u001b" || key === "\u0003") return settle("");
        if (key >= " " && key <= "~") return settle(key);
      }
    };

    try { stdin.setRawMode(true); } catch { /* best effort */ }
    stdin.on("data", onData);
    try { stdin.resume(); } catch { /* best effort */ }
    stdout.write(prompt);
  });
}

export class ReviewSession {
  constructor(deps = {}) {
    Object.assign(this, deps);
  }

  targetBranch() {
    if (typeof this.getTargetBranch === "function") return this.getTargetBranch();
    return this.TARGET_BRANCH;
  }

  async cmdReview() {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
      gitMergeToTargetAsync,
      cleanupWiBranchAsync,
      commitInScopeChangesAsyncFn,
      discardWorktreeFilesAsyncFn,
      stashTargetBranchChangesAsyncFn,
    } = this;

  const reviewAutoMerge = await withMergeLock(() => autoMergeCompletedWorkItems({ reason: "review" }));
  if (!reviewAutoMerge.acquired) {
    console.log(`\n  ${C.yellow}Auto-merge skipped: another merge is already in progress.${C.reset}`);
  }
  const targetDirtyAtReviewStart = await this._announceDirtyTargetBeforeAutoMerge(null);
  const workItems = listWorkItems(["complete", "failed"]).filter(isReviewableWorkItem);

  if (workItems.length === 0) {
    if (targetDirtyAtReviewStart) {
      console.log(`  ${C?.yellow || ""}No work items to review, but the target branch is dirty. Resolve those changes before relying on auto-merge or push.${C?.reset || ""}\n`);
    } else {
      console.log(`\n  No work items to review.\n`);
    }
    return;
  }

  // Use TUI approval mode with full reports when possible
  const useTui = !NO_TUI && process.stdout.isTTY;
  if (useTui) {
    const display = new Display({ concurrency: 0 });
    try {
      display.start();
      await this.wrapUpTui(display);
    } finally {
      display.stop();
    }
    return;
  }

  // Fallback: text-based review (no TTY)
  cmdDashboard();

  console.log(`\n  ${C.bold}Review each work item:${C.reset}\n`);
  let textReportsByWi = new Map();
  try {
    const reports = await this.buildReviewReportDataAsync(workItems);
    textReportsByWi = new Map(reports.map((report) => [Number(report.wi.id), report]));
  } catch {
    textReportsByWi = new Map();
  }

  let mergedCount = 0;
  for (const wi of workItems) {
    const jobs = listJobsByWorkItem(wi.id);
    const succeeded = jobs.filter((j) => j.status === "succeeded").length;
    const failed = jobs.filter((j) => FAILED_JOB_STATUSES.includes(j.status)).length;

    const statusIcon = failed > 0 ? `${C.yellow}!` :
                       succeeded === jobs.length ? `${C.green}+` :
                       `${C.cyan}~`;

    console.log(`  ${statusIcon} ${C.bold}[WI#${wi.id}]${C.reset} ${wi.title.slice(0, 50)}`);
    console.log(`     ${C.dim}${succeeded}/${jobs.length} jobs succeeded${failed > 0 ? `, ${failed} failed` : ""}${C.reset}`);
    const report = textReportsByWi.get(Number(wi.id));
    if (report?.finalAssessment) {
      const assessment = report.finalAssessment;
      const color = assessment.status === "PASS" ? C.green : assessment.status === "FAIL" ? C.red : C.yellow;
      console.log(`     ${C.bold}Final Assessment:${C.reset} ${color}${assessment.status}${C.reset} ${C.dim}${assessment.reason || ""}${C.reset}`);
    }
    if (report?.memoriesSurfaced) {
      console.log(`     ${C.bold}Memories surfaced:${C.reset} ${report.memoriesSurfaced.length || 0}${report.memoriesSurfaced.length > 0 ? ` ${C.dim}(review: note | suppress | correct)${C.reset}` : ""}`);
    }
    if (report?.finalAssessment?.status === "BLOCKED") {
      console.log(`     ${C.yellow}This WI is blocked until dirty tree or memory-review blockers are resolved.${C.reset}`);
    }

    const choice = await ask(`     (a)pprove / (r)eject / (d)elete / (s)kip: `);

    if (choice.toLowerCase() === "a") {
      const report = textReportsByWi.get(Number(wi.id));
      if (report?.finalAssessment?.status === "BLOCKED") {
        console.log(`     ${C.red}Approval blocked: ${report.finalAssessment.reason}${C.reset}`);
        continue;
      }
      const completionOk = updateWorkItemStatus(wi.id, "complete", { allowTerminalFailureBlockers: true });
      if (completionOk === false) {
        console.log(`     ${C.red}Approval blocked: active jobs or dirty review state must be resolved before merge.${C.reset}`);
        continue;
      }
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: "Approved via text review",
        event_json: JSON.stringify({ approval_type: "human" }),
      });

      // Merge branch into target branch
      if (wi.branch_name) {
        const mergeFn = gitMergeToTargetAsync || gitMergeToTarget;
        const mergeOutcome = await withMergeLock(() => mergeFn(wi.branch_name, PROJECT_DIR, {
          wiId: wi.id,
          onPhase(event = {}) {
            if (event.phase === "atlas-indexing") console.log(`     ${C.cyan}ATLAS Indexing${C.reset}`);
            else if (event.phase === "retry") console.log(`     ${C.yellow}Retrying merge...${C.reset}`);
            else if (event.phase === "merge") console.log(`     ${C.cyan}Merging....${C.reset}`);
          },
        }));
        const result = mergeOutcome.result;
        if (!mergeOutcome.acquired) {
          console.log(`     ${C.green}Approved${C.reset} ${C.yellow}(merge skipped: another merge is already in progress)${C.reset}\n`);
        } else if (result.ok) {
          const targetBranch = result.targetBranch || this.targetBranch();
          const mergeHash = result.mergeHash || "(unknown)";
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGED,
            actor_type: EVENT_ACTORS.HUMAN,
            message: `Merged ${wi.branch_name} into ${targetBranch} at ${mergeHash}`,
            event_json: JSON.stringify({ branch: wi.branch_name, merge_hash: mergeHash, target_branch: targetBranch }),
          });
          setMergeState(wi.id, "merged");
          const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
          const cleanupOk = await cleanupFn(wi);
          console.log(`     ${C.green}Approved + merged${C.reset} (${mergeHash.slice(0, 8)})${cleanupOk ? "" : ` ${C.yellow}(branch cleanup failed)${C.reset}`}\n`);
          mergedCount++;
        } else if (result.deferred) {
          console.log(`     ${C.green}Approved${C.reset} ${C.yellow}(${result.message})${C.reset}\n`);
        } else {
          setMergeState(wi.id, "merge_failed");
          console.log(`     ${C.green}Approved${C.reset} ${C.red}(merge failed: ${result.message})${C.reset}\n`);
        }
      } else {
        console.log(`     ${C.green}Approved${C.reset}\n`);
      }
    } else if (choice.toLowerCase() === "r") {
      const reason = await ask(`     Reason (or enter to skip): `);
      // Clean up branch/worktree, then re-queue
      if (wi.branch_name) {
        const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
        const cleanupOk = await cleanupFn(wi, { clearMergeState: true });
        if (!cleanupOk) {
          console.log(`     ${C.red}Rejected, but branch cleanup failed; leaving WI unchanged${C.reset}\n`);
          continue;
        }
      }
      const newDesc = reason
        ? `${wi.description}\n\n---\nPREVIOUS ATTEMPT REJECTED: ${reason}`
        : wi.description;
      requeueWorkItemAfterRejection(wi.id, { description: newDesc });

      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.WORK_ITEM_REJECTED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: reason || "Rejected without reason",
      });

      console.log(`     ${C.yellow}Rejected → re-queued${C.reset}\n`);
    } else if (choice.toLowerCase() === "d") {
      // Delete — clean up and cancel
      if (wi.branch_name) {
        const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
        const cleanupOk = await cleanupFn(wi, { clearMergeState: true });
        if (!cleanupOk) {
          console.log(`     ${C.red}Delete skipped; branch cleanup failed${C.reset}\n`);
          continue;
        }
      }
      updateWorkItemStatus(wi.id, "canceled");
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.WORK_ITEM_DELETED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: "Deleted via text review",
      });
      console.log(`     ${C.red}Deleted${C.reset}\n`);
    } else {
      console.log(`     ${C.dim}Skipped${C.reset}\n`);
    }
  }

  // Summary
  const approvedCount = listWorkItems("complete").length;
  const requeued = listWorkItems("queued").length;
  console.log(`\n  ${C.bold}Result:${C.reset} ${C.green}${approvedCount} approved${C.reset}${requeued > 0 ? `  ${C.yellow}${requeued} re-queued${C.reset}` : ""}\n`);

  // Offer to push if anything was merged
  if (mergedCount > 0) {
    await offerPush(mergedCount);
  }

  await (this.ensureCleanTargetBranchAsync || ensureCleanTargetBranch)("review wrap-up", { logWhenClean: true });

  }

  async wrapUp() {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      mergeIterativePassToTarget,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
      gitMergeToTargetAsync,
      cleanupWiBranchAsync,
      commitInScopeChangesAsyncFn,
      discardWorktreeFilesAsyncFn,
      stashTargetBranchChangesAsyncFn,
    } = this;

  cleanupRunningAgentCalls();
  const allJobs = listJobs();
  const succeeded = allJobs.filter((j) => j.status === "succeeded").length;
  const failed = allJobs.filter((j) => FAILED_JOB_STATUSES.includes(j.status)).length;
  const blocked = allJobs.filter((j) => j.status === "blocked").length;

  cmdDashboard();

  console.log(`  ${C.bold}Execution complete: ${succeeded} succeeded, ${failed} failed, ${blocked} blocked of ${allJobs.length} total${C.reset}`);

  // Notify about dirty worktrees/branches before review/push decisions
  await notifyDirtyState();
  const iterateResult = await processIterativeWrapUp({
    reason: "run wrap-up",
    mergeIterativePassToTarget,
  });
  if (iterateResult.rerun) {
    console.log(`  ${C.cyan}[iterate]${C.reset} Queued ${iterateResult.spawned} iterative next-pass job set(s). Continuing automatically.\n`);
    return iterateResult;
  }

  // Target-branch dirt is the #1 silent killer of auto-merge: gitMergeToTarget
  // refuses every dirty target. Surface it now and point at the [t] key in
  // review so the user knows how to recover during the upcoming approval flow.
  await this._announceDirtyTargetBeforeAutoMerge();

  const wrapUpAutoMerge = await withMergeLock(() => autoMergeCompletedWorkItems({ reason: "run wrap-up" }));
  if (!wrapUpAutoMerge.acquired) {
    console.log(`  ${C.yellow}Auto-merge skipped: another merge is already in progress.${C.reset}`);
  }
  const autoMergedNow = wrapUpAutoMerge.acquired ? wrapUpAutoMerge.result : 0;
  const mergeFailures = this._listMergeFailedAfterAutoMerge();

  if (mergeFailures.length > 0) {
    console.log(`\n  ${C.red}${C.bold}⚠ ${mergeFailures.length} work item(s) failed to auto-merge${C.reset}`);
    for (const wi of mergeFailures.slice(0, 5)) {
      console.log(`    ${C.cyan}WI#${wi.id}${C.reset} ${(wi.title || "").slice(0, 60)} ${C.dim}(${wi.branch_name})${C.reset}`);
    }
    if (mergeFailures.length > 5) {
      console.log(`    ${C.dim}… and ${mergeFailures.length - 5} more${C.reset}`);
    }
    console.log(`  ${C.dim}Opening review so you can see why and fix it (target stash / commit dirty / discard).${C.reset}\n`);
    await this.cmdReview();
    return;
  }

  const hasReviewable = listWorkItems(["complete", "running", "planned"]).some(isReviewableWorkItem);
  if (hasReviewable) {
    const doReview = await ask(`\n  Review and approve work items now? (y/n): `);
    if (doReview.toLowerCase() === "y") {
      await this.cmdReview();
      return;
    } else {
      console.log(`  ${C.dim}Run 'review' anytime to approve work items.${C.reset}\n`);
    }
  }

  // If review was skipped or nothing to review, check for auto-merged WIs and offer push
  if (autoMergedNow > 0) {
    await offerPush(autoMergedNow);
  }

  // ── Review assessor suggestions (always, even if WI review was skipped) ──
  await this.reviewSuggestions();
  await (this.ensureCleanTargetBranchAsync || ensureCleanTargetBranch)("run wrap-up", { logWhenClean: true });
  return iterateResult;

  }

  saveReport(reportData) {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
      gitMergeToTargetAsync,
      cleanupWiBranchAsync,
      commitInScopeChangesAsyncFn,
      discardWorktreeFilesAsyncFn,
      stashTargetBranchChangesAsyncFn,
    } = this;

  return saveReportFromModule(reportData, { projectDir: PROJECT_DIR });

  }

  listReviewableWorkItemsForApproval() {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  return listReviewableWorkItemsForApprovalFromModule(isReviewableWorkItem);

  }

  buildReviewReportData(reviewable) {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  return buildReviewReportDataFromModule(reviewable, {
    projectDir: PROJECT_DIR,
    gitDiffStat: this.gitDiffStatAsync ? null : gitDiffStat,
    targetBranch: this.targetBranch(),
    worktreeStatusFn: this.worktreeStatusAsyncFn ? null : this.worktreeStatusFn,
  });

  }

  async buildReviewReportDataAsync(reviewable) {
    const reportData = this.buildReviewReportData(reviewable);
    const diffFn = this.gitDiffStatAsync;
    if (typeof diffFn === "function") {
      await Promise.all(reportData.map(async (item) => {
        if (!item?.wi?.branch_name || !item?.wi?.merge_base_hash) return;
        try {
          item.gitDiff = await diffFn(item.wi.merge_base_hash, item.wi.branch_name, this.PROJECT_DIR);
        } catch {
          item.gitDiff = [];
        }
      }));
    }
    const statusFn = this.worktreeStatusAsyncFn;
    if (typeof statusFn !== "function") return reportData;
    await Promise.all(reportData.map(async (item) => {
      try {
        item.worktreeStatus = await statusFn({
          wi: item.wi,
          jobs: item.jobs || [],
          projectDir: this.PROJECT_DIR,
          targetBranch: this.targetBranch(),
        });
        item.finalAssessment = finalAssessmentFor({
          wi: item.wi,
          jobs: item.jobs || [],
          worktreeStatus: item.worktreeStatus,
          memoriesSurfaced: item.memoriesSurfaced || [],
        });
      } catch {
        item.worktreeStatus = null;
      }
    }));
    return reportData;
  }

  installApprovalActions(display, reportData) {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
      gitMergeToTargetAsync,
      cleanupWiBranchAsync,
      commitInScopeChangesAsyncFn,
      discardWorktreeFilesAsyncFn,
      stashTargetBranchChangesAsyncFn,
    } = this;

  const currentTargetBranch = () => this.targetBranch();
  let mergeQueue = Promise.resolve();
  display._mergeQueuePromise = () => mergeQueue;
  const RENDER_FLUSH_DELAY_MS = 40;

  function setApprovalOverlay(title = null, item = null) {
    if (typeof display.setBlockingOverlay !== "function") return;
    if (!title) {
      display.setBlockingOverlay(null);
      return;
    }
    const wiLabel = item?.wi?.id != null ? `WI#${item.wi.id}` : "";
    display.setBlockingOverlay(title, wiLabel ? `${wiLabel} - please wait` : "Please wait");
  }

  function enqueueGitWork(item, run, { overlay = "Merging....", advanceAfter = true } = {}) {
    item._mergeInFlight = true;
    item._mergePhase = overlay;
    display._approvalActionBusy = true;
    setApprovalOverlay(overlay, item);
    display.requestRender({ force: true });
    mergeQueue = mergeQueue.then(() => new Promise((resolve) => {
      setTimeout(() => {
        const phase = (title, event = {}) => {
          item._mergePhase = title;
          setApprovalOverlay(title, item);
          if (typeof display.addEvent === "function") {
            const wiLabel = item?.wi?.id != null ? `WI#${item.wi.id}` : "Work item";
            const branch = event.branch || item?.wi?.branch_name || "branch";
            const target = event.target || currentTargetBranch();
            if (event.phase === "atlas-indexing") {
              return;
            } else if (event.phase === "retry") {
              display.addEvent(`${C.yellow}[review]${C.reset} ${wiLabel}: retrying merge`);
            } else if (event.phase === "merge") {
              display.addEvent(`${C.cyan}[review]${C.reset} ${wiLabel}: merging ${branch} into ${target}`);
            }
          }
          display.requestRender({ force: true });
        };
        Promise.resolve()
          .then(() => run({ phase }))
          .catch((err) => {
            item._mergeResult = `${C.red}\u2717 ${err?.message || String(err)}${C.reset}`;
          })
          .finally(() => {
            item._mergeInFlight = false;
            item._mergePhase = null;
            display._approvalActionBusy = false;
            setApprovalOverlay(null);
            display.requestRender({ force: true });
            if (advanceAfter && typeof display._advanceApproval === "function") {
              display._advanceApproval();
            }
            resolve();
          });
      }, RENDER_FLUSH_DELAY_MS);
    }));
  }

  function refreshApprovalItem(item, action) {
    const fresh = getWorkItem(item.wi.id);
    if (!fresh) {
      item._mergeResult = `${C.red}\u2717 WI#${item.wi.id} no longer exists; ${action} refused${C.reset}`;
      display.requestRender({ force: true });
      return null;
    }
    const statusChanged = fresh.status !== item.wi.status;
    const branchChanged = (fresh.branch_name || null) !== (item.wi.branch_name || null);
    const mergeStateChanged = (fresh.merge_state || null) !== (item.wi.merge_state || null);
    const mergeStateRefreshOnly = !statusChanged && !branchChanged && mergeStateChanged;
    const canRefreshMergeState = mergeStateRefreshOnly
      && (fresh.merge_state || null) !== "merged";
    const changed = statusChanged || branchChanged || (mergeStateChanged && !canRefreshMergeState);
    if (changed) {
      item._mergeResult = `${C.red}\u2717 WI#${item.wi.id} changed since review loaded; refresh before ${action}${C.reset}`;
      display.requestRender({ force: true });
      return null;
    }
    item.wi = fresh;
    return fresh;
  }

  display.onApprovalAction = (wiId, action) => {
    const item = reportData.find(d => d.wi.id === wiId);
    if (!item) return false;

    if (action === "approve") {
      const freshWi = refreshApprovalItem(item, "approve");
      if (!freshWi) return false;
      const mergeBlocker = this._approvalMergeBlocker(item);
      if (mergeBlocker) {
        item._mergeResult = `${C.red}\u2717 ${mergeBlocker}${C.reset}`;
        display.requestRender({ force: true });
        return false;
      }
      const completionOk = updateWorkItemStatus(wiId, "complete", { allowTerminalFailureBlockers: true });
      if (completionOk === false) {
        item._mergeResult = `${C.red}\u2717 Approval blocked: active required jobs remain; resolve them before merging${C.reset}`;
        display.requestRender({ force: true });
        return false;
      }
      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: "Approved via TUI review",
        event_json: JSON.stringify({ approval_type: "human" }),
      });

      if (!freshWi.branch_name) return true;

      enqueueGitWork(item, async ({ phase }) => {
        const mergeFn = gitMergeToTargetAsync || gitMergeToTarget;
        const mergeOutcome = await withMergeLock(() => mergeFn(freshWi.branch_name, PROJECT_DIR, {
          wiId,
          onPhase(event = {}) {
            if (event.phase === "atlas-indexing") phase("ATLAS Indexing", event);
            else if (event.phase === "merge") phase("Merging....", event);
            else if (event.phase === "retry") phase("Retrying Merge....", event);
          },
        }));
        if (!mergeOutcome.acquired) {
          item._mergeResult = `${C.yellow}! merge skipped: another merge is already in progress${C.reset}`;
          return;
        }
        const result = mergeOutcome.result;
        if (result.ok) {
          const targetBranch = result.targetBranch || this.targetBranch();
          const mergeHash = result.mergeHash || "(unknown)";
          logEvent({
            work_item_id: wiId,
            event_type: EVENT_TYPES.WORK_ITEM_MERGED,
            actor_type: EVENT_ACTORS.HUMAN,
            message: `Merged ${freshWi.branch_name} into ${targetBranch} at ${mergeHash}`,
            event_json: JSON.stringify({ branch: freshWi.branch_name, merge_hash: mergeHash, target_branch: targetBranch }),
          });
          setMergeState(wiId, "merged");
          const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
          const cleanupOk = await cleanupFn(freshWi);
          if (typeof display.addEvent === "function") {
            display.addEvent(`${C.green}[review]${C.reset} WI#${wiId}: merged ${freshWi.branch_name} into ${targetBranch} at ${mergeHash.slice(0, 8)}${cleanupOk ? "; cleaned up branch/worktree" : "; branch cleanup failed"}`);
          }
          item._mergeResult = `${C.green}\u2713 ${result.message}${C.reset} (${mergeHash.slice(0, 8)})${cleanupOk ? "" : ` ${C.yellow}(branch cleanup failed)${C.reset}`}`;
        } else if (result.deferred) {
          item._mergeResult = `${C.yellow}! ${result.message}${C.reset}`;
        } else {
          setMergeState(wiId, "merge_failed");
          item._mergeResult = `${C.red}\u2717 ${result.message}${C.reset}`;
        }
      }, { overlay: "Merging....", advanceAfter: true });
      return { deferAdvance: true };
    } else if (action === "reject") {
      const freshWi = refreshApprovalItem(item, "reject");
      if (!freshWi) return false;
      enqueueGitWork(item, async () => {
        const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
        const cleanupOk = await cleanupFn(freshWi, { clearMergeState: true });
        if (!cleanupOk) {
          item._mergeResult = `${C.red}\u2717 branch cleanup failed; WI unchanged${C.reset}`;
          return;
        }
        requeueWorkItemAfterRejection(wiId);
        logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.WORK_ITEM_REJECTED,
          actor_type: EVENT_ACTORS.HUMAN,
          message: "Rejected & re-queued via TUI review",
        });
        item._mergeResult = `${C.yellow}\u21bb re-queued${C.reset}`;
      }, { overlay: "Updating Review....", advanceAfter: true });
      return { deferAdvance: true };
    } else if (action === "delete") {
      const freshWi = refreshApprovalItem(item, "delete");
      if (!freshWi) return false;
      enqueueGitWork(item, async () => {
        const cleanupFn = cleanupWiBranchAsync || cleanupWiBranch;
        const cleanupOk = await cleanupFn(freshWi, { clearMergeState: true });
        if (!cleanupOk) {
          item._mergeResult = `${C.red}\u2717 branch cleanup failed; WI unchanged${C.reset}`;
          return;
        }
        updateWorkItemStatus(wiId, "canceled");
        logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.WORK_ITEM_DELETED,
          actor_type: EVENT_ACTORS.HUMAN,
          message: "Rejected & deleted via TUI review",
        });
        item._mergeResult = `${C.red}\u2717 deleted${C.reset}`;
      }, { overlay: "Updating Review....", advanceAfter: true });
      return { deferAdvance: true };
    } else if (action === "commit_dirty") {
      const ws = item.worktreeStatus;
      if (!ws || !ws.wtDir || !ws.wtExists) {
        item._mergeResult = `${C.yellow}! No worktree to commit${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      const inScopeCount = (ws.wtFiles || []).filter((f) => f.inScope).length;
      if (inScopeCount === 0) {
        item._mergeResult = `${C.yellow}! No in-scope dirty files to commit${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      enqueueGitWork(item, async () => {
        const commitFn = commitInScopeChangesAsyncFn || this.commitInScopeChangesFn;
        const result = await commitFn({
          wtDir: ws.wtDir,
          scope: ws.scope,
        });
        if (result.ok) {
          logEvent({
            work_item_id: wiId,
            event_type: EVENT_TYPES.GIT_REVIEW_COMMIT_DIRTY,
            actor_type: EVENT_ACTORS.HUMAN,
            message: result.message || `Committed ${result.paths?.length || 0} in-scope dirty file(s) via review`,
            event_json: JSON.stringify({ wt_dir: ws.wtDir, paths: result.paths || [], reverted: result.reverted || [] }),
          });
          item._mergeResult = `${C.green}\u2713 ${result.message}${C.reset}`;
        } else {
          item._mergeResult = `${C.red}\u2717 ${result.message}${C.reset}`;
        }
        await this._refreshWorktreeStatus(item);
      }, { overlay: "Committing....", advanceAfter: false });
      return { deferAdvance: true };
    } else if (action === "stash_target") {
      const ws = item.worktreeStatus;
      if (!ws || !ws.targetDirty) {
        item._mergeResult = `${C.yellow}! Target branch is already clean${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      enqueueGitWork(item, async () => {
        const stashFn = stashTargetBranchChangesAsyncFn || this.stashTargetBranchChangesFn;
        const result = await stashFn({ projectDir: PROJECT_DIR, targetBranch: this.targetBranch() });
        if (result.ok) {
          logEvent({
            work_item_id: wiId,
            event_type: EVENT_TYPES.GIT_REVIEW_STASH_TARGET,
            actor_type: EVENT_ACTORS.HUMAN,
            message: `Stashed target-branch changes during review (${ws.targetFiles.length} file(s))`,
            event_json: JSON.stringify({ target_branch: this.targetBranch(), file_count: ws.targetFiles.length }),
          });
          item._mergeResult = `${C.green}\u2713 ${result.message}${C.reset}`;
        } else {
          item._mergeResult = `${C.red}\u2717 ${result.message}${C.reset}`;
        }
        // Stashing the target branch affects every report item, not just this one.
        await Promise.all(reportData.map((other) => this._refreshWorktreeStatus(other)));
      }, { overlay: "Stashing target....", advanceAfter: false });
      return { deferAdvance: true };
    } else if (action === "discard_dirty") {
      const ws = item.worktreeStatus;
      const wtFiles = Array.isArray(ws?.wtFiles) ? ws.wtFiles : [];
      const targetFiles = Array.isArray(ws?.targetFiles) ? ws.targetFiles : [];
      const discardable = wtFiles.filter((f) => !f.inScope);
      if (targetFiles.length > 0) {
        item._mergeResult = `${C.yellow}! Select target file(s) to discard, then press Enter${C.reset}`;
      } else if (ws?.targetDirty) {
        item._mergeResult = `${C.yellow}! Target branch is dirty but no file list is available; press [t] to stash or refresh review${C.reset}`;
      } else if (!ws || !ws.wtDir || !ws.wtExists) {
        item._mergeResult = `${C.yellow}! No worktree to discard from${C.reset}`;
      } else if (wtFiles.length === 0) {
        item._mergeResult = `${C.yellow}! Worktree is already clean${C.reset}`;
      } else if (discardable.length === 0) {
        item._mergeResult = `${C.yellow}! No out-of-scope or untracked files to discard; use [c] to commit in-scope dirt${C.reset}`;
      } else {
        item._mergeResult = `${C.yellow}! Select file(s) to discard, then press Enter${C.reset}`;
      }
      display.requestRender({ force: true });
      return { deferAdvance: true };
    } else if (action && typeof action === "object" && action.kind === "discard_files") {
      const ws = item.worktreeStatus;
      const paths = Array.isArray(action.paths) ? action.paths : [];
      if (paths.length === 0) {
        item._mergeResult = `${C.dim}Discard canceled (no files selected)${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      const actionFiles = Array.isArray(action.files) && action.files.length > 0
        ? action.files
        : paths.map((p) => ({ path: p, location: action.location === "target" ? "target" : "worktree" }));
      const targetAllowed = new Set((ws?.targetFiles || []).map((f) => String(f.path || "")));
      const worktreeAllowed = new Set((ws?.wtFiles || []).filter((f) => !f.inScope).map((f) => String(f.path || "")));
      const targetPaths = [];
      const worktreePaths = [];
      for (const entry of actionFiles) {
        const p = String(entry?.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
        if (!p) continue;
        if (entry?.location === "target") {
          if (targetAllowed.has(p)) targetPaths.push(p);
        } else if (worktreeAllowed.has(p)) {
          worktreePaths.push(p);
        }
      }
      const uniq = (list) => [...new Set(list)];
      const selectedTargetPaths = uniq(targetPaths);
      const selectedWorktreePaths = uniq(worktreePaths);
      const selectedCount = selectedTargetPaths.length + selectedWorktreePaths.length;
      if (selectedCount === 0) {
        item._mergeResult = `${C.yellow}! Selected file(s) are no longer dirty; refresh review and try again${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      if (selectedWorktreePaths.length > 0 && (!ws || !ws.wtDir || !ws.wtExists)) {
        item._mergeResult = `${C.yellow}! No worktree to discard selected worktree file(s) from${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      const targetDir = ws?.targetDir || PROJECT_DIR;
      if (selectedTargetPaths.length > 0 && !targetDir) {
        item._mergeResult = `${C.yellow}! No target checkout to discard selected target file(s) from${C.reset}`;
        display.requestRender({ force: true });
        return { deferAdvance: true };
      }
      enqueueGitWork(item, async () => {
        const discardFn = discardWorktreeFilesAsyncFn || this.discardWorktreeFilesFn;
        const results = [];
        if (selectedTargetPaths.length > 0) {
          results.push({
            location: "target",
            paths: selectedTargetPaths,
            result: await discardFn({ wtDir: targetDir, paths: selectedTargetPaths, targetBranch: this.targetBranch() }),
          });
        }
        if (selectedWorktreePaths.length > 0) {
          results.push({
            location: "worktree",
            paths: selectedWorktreePaths,
            result: await discardFn({ wtDir: ws.wtDir, paths: selectedWorktreePaths, targetBranch: this.targetBranch() }),
          });
        }
        const failed = results.find((entry) => !entry.result?.ok);
        if (!failed) {
          const cleanedPaths = results.flatMap((entry) => entry.result.paths || entry.paths || []);
          logEvent({
            work_item_id: wiId,
            event_type: EVENT_TYPES.GIT_REVIEW_DISCARD_FILES,
            actor_type: EVENT_ACTORS.HUMAN,
            message: `Discarded ${selectedCount} dirty file(s) via review`,
            event_json: JSON.stringify({
              wt_dir: ws?.wtDir || null,
              target_dir: targetDir || null,
              worktree_paths: selectedWorktreePaths,
              target_paths: selectedTargetPaths,
            }),
          });
          const where = [
            selectedTargetPaths.length > 0 ? `${selectedTargetPaths.length} target` : null,
            selectedWorktreePaths.length > 0 ? `${selectedWorktreePaths.length} worktree` : null,
          ].filter(Boolean).join(", ");
          item._mergeResult = `${C.green}\u2713 Discarded ${cleanedPaths.length || selectedCount} file(s)${where ? ` (${where})` : ""}${C.reset}`;
        } else {
          item._mergeResult = `${C.red}\u2717 ${failed.location} discard failed: ${failed.result?.message || "unknown error"}${C.reset}`;
        }
        if (selectedTargetPaths.length > 0) {
          await Promise.all(reportData.map((other) => this._refreshWorktreeStatus(other)));
        } else {
          await this._refreshWorktreeStatus(item);
        }
      }, { overlay: "Discarding....", advanceAfter: false });
      return { deferAdvance: true };
    }
    return false;
  };

  }

  _approvalMergeBlocker(item) {
    const ws = item?.worktreeStatus;
    if (!ws) return null;
    const wtFiles = Array.isArray(ws.wtFiles) ? ws.wtFiles : [];
    if (wtFiles.length > 0) {
      const inScope = wtFiles.filter((file) => file?.inScope).length;
      const outOfScope = wtFiles.length - inScope;
      const parts = [
        `${wtFiles.length} dirty WI worktree file${wtFiles.length === 1 ? "" : "s"}`,
        inScope > 0 ? `${inScope} in scope` : null,
        outOfScope > 0 ? `${outOfScope} out of scope/untracked` : null,
      ].filter(Boolean).join(", ");
      return `Approval blocked: resolve ${parts} before merging`;
    }
    const targetFiles = Array.isArray(ws.targetFiles) ? ws.targetFiles : [];
    if (ws.targetDirty || targetFiles.length > 0) {
      const count = targetFiles.length || 1;
      return `Approval blocked: target branch has ${count} uncommitted change${count === 1 ? "" : "s"}; stash, commit, or discard before merging`;
    }
    return null;
  }

  async _refreshWorktreeStatus(item) {
    const statusFn = this.worktreeStatusAsyncFn || this.worktreeStatusFn;
    if (!item?.wi || typeof statusFn !== "function") return;
    try {
      item.worktreeStatus = await statusFn({
        wi: item.wi,
        jobs: item.jobs || [],
        projectDir: this.PROJECT_DIR,
        targetBranch: this.targetBranch(),
      });
      item.finalAssessment = finalAssessmentFor({
        wi: item.wi,
        jobs: item.jobs || [],
        worktreeStatus: item.worktreeStatus,
        memoriesSurfaced: item.memoriesSurfaced || [],
      });
    } catch {
      // Best-effort refresh; the panel will continue to show the prior state.
    }
  }

  _announceDirtyTargetBeforeAutoMerge(display = null) {
    const statusFn = this.worktreeStatusAsyncFn || this.worktreeStatusFn;
    if (typeof statusFn !== "function") return false;
    const render = (status) => {
      const targetFiles = Array.isArray(status?.targetFiles) ? status.targetFiles : [];
      if (!status || (!status.targetDirty && targetFiles.length === 0)) return false;
      const C = this.C || {};
      const red = C.red || "";
      const bold = C.bold || "";
      const reset = C.reset || "";
      const fileCount = targetFiles.length || 1;
      const msg = `⚠ Target branch ${this.targetBranch()} has ${fileCount} uncommitted change(s) — auto-merge will refuse every WI until this is resolved. Review will offer [t] to stash it.`;
      if (display && typeof display.addEvent === "function") {
        display.addEvent(`${red}${msg}${reset}`);
      } else {
        console.log(`\n  ${red}${bold}${msg}${reset}\n`);
      }
      return true;
    };
    try {
      const status = statusFn({
        wi: { id: null, branch_name: null },
        jobs: [],
        projectDir: this.PROJECT_DIR,
        targetBranch: this.targetBranch(),
      });
      if (status && typeof status.then === "function") {
        return status.then(render).catch(() => false);
      }
      return render(status);
    } catch {
      return false;
    }
  }

  _listMergeFailedAfterAutoMerge() {
    const { listWorkItems } = this;
    try {
      return listWorkItems(["complete", "failed"]).filter((wi) => wi.merge_state === "merge_failed" && wi.branch_name);
    } catch {
      return [];
    }
  }

  async runLiveReview(display) {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  const reviewStart = createTuiWrapUpTracker(display, {
    title: "Review startup",
    subtitle: "Checking completed work before opening review.",
    steps: [
      { id: "target", label: "Check target branch" },
      { id: "auto-merge", label: "Auto-merge eligible work" },
      { id: "review-data", label: "Load review queue" },
    ],
  });
  let autoMergedNow = 0;
  let targetDirtyAtReviewStart = false;
  let reviewable = [];
  let reportData = [];
  try {
    targetDirtyAtReviewStart = await reviewStart.run("target", () => this._announceDirtyTargetBeforeAutoMerge(display), {
      doneDetail: (dirty) => dirty ? "dirty" : "clean",
    });
    autoMergedNow = await reviewStart.run("auto-merge", async () => {
      const outcome = await withMergeLock(() => autoMergeCompletedWorkItems({ display, reason: "live review" }));
      if (!outcome.acquired) {
        display.addEvent(`${C.yellow}Auto-merge skipped: another merge is already in progress.${C.reset}`);
        return 0;
      }
      return outcome.result;
    }, {
      doneDetail: (count) => count > 0 ? `${count} merged` : "none",
    });
    reviewable = await reviewStart.run("review-data", () => this.listReviewableWorkItemsForApproval(), {
      doneDetail: (items) => items.length > 0 ? `${items.length} item${items.length === 1 ? "" : "s"}` : "none",
    });
    if (reviewable.length === 0) {
      if (targetDirtyAtReviewStart) {
        display.addEvent(`${C.red || ""}Target branch still has uncommitted changes; resolve them before relying on auto-merge or push.${C.reset || ""}`);
      } else {
        display.addEvent(autoMergedNow > 0
          ? `${C.dim}No pending work items to review after auto-merge.${C.reset}`
          : `${C.dim}No pending work items to review.${C.reset}`);
      }
      display.requestRender({ force: true });
      return;
    }

    reportData = await reviewStart.run("review-data", () => this.buildReviewReportDataAsync(reviewable), {
      doneDetail: (items) => `${items.length} report${items.length === 1 ? "" : "s"}`,
    });
  } finally {
    reviewStart.clear();
  }
  this.installApprovalActions(display, reportData);

  for (const item of reportData) {
    const hadWriteJob = item.jobs.some(jobIsWriteStep);
    item._isInfo = !hadWriteJob;
    if (item._isInfo) item._decision = "info";
  }

  const firstActionable = reportData.findIndex(d => !d._isInfo);
  display.addEvent(`${C.cyan}Opening review for ${reviewable.length} pending work item(s)${C.reset}`);
  await display.enterApprovalMode(reportData, firstActionable >= 0 ? firstActionable : 0);

  const closeout = createTuiWrapUpTracker(display, {
    title: "Review closeout",
    subtitle: "Finishing review work before returning to the queue.",
    steps: [
      { id: "git", label: "Finish queued git work" },
      { id: "report", label: "Save review report" },
      { id: "return", label: "Return to queue" },
    ],
  });
  try {
    await closeout.run("git", async () => {
      try {
        if (typeof display._mergeQueuePromise === "function") {
          await display._mergeQueuePromise();
        }
      } catch {
        // Queue errors are captured into item._mergeResult by approval actions.
      }
    });
    await closeout.run("report", () => this.saveReport(reportData));
    const approved = reportData.filter(d => d._decision === "approved").length;
    await closeout.run("return", () => {
      display._mode = "normal";
      display._approvalData = [];
      display._approvalDone = null;
      display.addEvent(`${C.green}Review closed${approved > 0 ? ` - ${approved} approved/merged` : ""}${C.reset}`);
      display.requestRender({ force: true });
    });
  } finally {
    if (typeof display._mode === "string" && display._mode !== "normal") {
      display._mode = "normal";
    }
    closeout.clear();
    display.requestRender({ force: true });
  }

  }

  describePendingReviewLockBlockers() {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  const blockers = [];
  for (const job of listJobs(["queued"])) {
    let scope = null;
    try { scope = getJobWriteScope(job); } catch { scope = null; }
    const conflict = scope ? findWriteLockConflict(job, scope) : null;
    if (conflict?.type !== "work_item") continue;
    const holder = getWorkItem(conflict.lock?.work_item_id);
    if (!holder || holder.merge_state !== "pending_review") continue;
    blockers.push({
      job,
      holder,
      path: conflict.candidate?.path || conflict.lock?.path || "unknown",
    });
  }
  if (blockers.length === 0) return null;

  const byWi = new Map();
  for (const blocker of blockers) {
    if (!byWi.has(blocker.holder.id)) {
      byWi.set(blocker.holder.id, { holder: blocker.holder, paths: new Set(), jobs: new Set() });
    }
    const entry = byWi.get(blocker.holder.id);
    entry.paths.add(blocker.path);
    entry.jobs.add(blocker.job.id);
  }
  const first = [...byWi.values()][0];
  const pathList = [...first.paths].slice(0, 3).join(", ");
  const extraPaths = first.paths.size > 3 ? ` +${first.paths.size - 3}` : "";
  const extraWis = byWi.size > 1 ? ` (+${byWi.size - 1} more WI)` : "";
  return `Queued work is blocked by WI#${first.holder.id} pending review on ${pathList}${extraPaths}${extraWis}. Press [r] review to approve/reject.`;

  }

  async reviewSuggestions() {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  const askChoice = this.askSingleKeyChoice || askSingleKeyChoice;
  const completedWIs = listWorkItems(["complete"]);
  const allSuggestions = [];

  for (const wi of completedWIs) {
    if (getIterativeState(wi)) continue;
    let handledSuggestionKeys = new Set();
    try { handledSuggestionKeys = collectHandledSuggestionKeys(getEventsByWorkItem(wi.id, 5000)); } catch { /* ignore */ }
    let reviewArtifacts = [];
    try { reviewArtifacts = getArtifactsByWorkItem(wi.id, "review"); } catch { continue; }
    for (const art of reviewArtifacts) {
      try {
        const data = JSON.parse(art.content_json || "{}");
        if (data.type === "suggestions" && Array.isArray(data.suggestions)) {
          for (let suggestionIndex = 0; suggestionIndex < data.suggestions.length; suggestionIndex++) {
            const s = data.suggestions[suggestionIndex];
            const suggestionKey = suggestionReviewKey({ artifactId: art.id, suggestionIndex, suggestion: s });
            if (handledSuggestionKeys.has(suggestionKey)) continue;
            allSuggestions.push({ wi, jobId: art.job_id, suggestion: s, artifactId: art.id, suggestionIndex, suggestionKey });
          }
        }
      } catch { /* skip bad json */ }
    }
  }

  if (allSuggestions.length === 0) return 0;

  console.log(`\n  ${C.bold}Assessor Suggestions (${allSuggestions.length}):${C.reset}\n`);

  let approvedCount = 0;
  for (let i = 0; i < allSuggestions.length; i++) {
    const { wi, jobId, suggestion, artifactId, suggestionIndex, suggestionKey } = allSuggestions[i];
    console.log(`  ${C.cyan}${i + 1}/${allSuggestions.length}${C.reset} ${C.dim}WI#${wi.id}${C.reset} ${wi.title.slice(0, 40)}`);
    console.log(`    ${suggestion.slice(0, 120)}`);

    let c = "";
    while (!["a", "s", "r"].includes(c)) {
      const choice = await askChoice(`    ${C.bold}(a)pprove / (s)kip / skip (r)est: ${C.reset}`, ["a", "s", "r"], { fallbackAsk: ask });
      c = choice.toLowerCase().trim();
      if (!["a", "s", "r"].includes(c)) {
        console.log(`    ${C.dim}Choose a, s, or r.${C.reset}`);
      }
    }

    if (c === "a") {
      // Parse file scope and gather context from the original job
      let originalFiles = [], originalCreateFiles = [], originalCreateRoots = [];
      let origTaskSpec = "";
      try {
        const origJob = getJob(jobId);
        const payload = parseJobPayload(origJob);
        originalFiles = Array.isArray(payload.files_to_modify) ? payload.files_to_modify : [];
        originalCreateFiles = Array.isArray(payload.files_to_create) ? payload.files_to_create : [];
        originalCreateRoots = Array.isArray(payload.create_roots) ? payload.create_roots : [];
        origTaskSpec = payload.task_spec || origJob?.title || "";
      } catch { /* no payload */ }

      const decision = suggestionDevJobDecision({
        suggestion,
        filesToModify: originalFiles,
        filesToCreate: originalCreateFiles,
        createRoots: originalCreateRoots,
      });
      if (!decision.ok) {
        console.log(`    ${C.yellow}Skipped:${C.reset} ${decision.reason}; not enough scoped repo work for a dev job.\n`);
        logEvent({
          work_item_id: wi.id,
          job_id: jobId,
          event_type: EVENT_TYPES.JOB_SUGGESTION_SKIPPED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Skipped approved suggestion (${decision.reason}): ${suggestion.slice(0, 80)}`,
          event_json: JSON.stringify(suggestionDecisionEventJson({
            artifactId,
            suggestionIndex,
            suggestion,
            decision: "skipped",
            reason: decision.reason,
          })),
        });
        continue;
      }

      // Build rich task_spec: original task context + what was done + assessor suggestion
      const specParts = [];

      // 1. Original task context (what the planner asked for)
      if (origTaskSpec) {
        specParts.push(`## Original Task\n${origTaskSpec}`);
      }

      // 1b. Latest WI summary / research context
      try {
        const summaries = getArtifactsByWorkItem(wi.id, "summary");
        if (summaries.length > 0) {
          const latestSummary = summaries[summaries.length - 1].content_long || "";
          if (latestSummary.trim()) {
            const trimmed = latestSummary.length > 2000 ? latestSummary.slice(0, 2000) + "\n...(truncated)" : latestSummary;
            specParts.push(`## Project Context\n${trimmed}`);
          }
        }
      } catch { /* no summary artifacts */ }

      // 2. What the original dev actually did (dev log / output)
      try {
        const devOutputs = getArtifacts(jobId, "response");
        if (devOutputs.length > 0) {
          const lastOutput = devOutputs[devOutputs.length - 1].content_long || "";
          // Include the dev log portion (truncate if huge)
          const trimmed = lastOutput.length > 2000 ? lastOutput.slice(0, 2000) + "\n...(truncated)" : lastOutput;
          specParts.push(`## What Was Already Done (dev log from job #${jobId})\n${trimmed}`);
        }
      } catch { /* no artifacts */ }

      // 3. The assessor's suggestion (the improvement to make)
      specParts.push(`## Improvement Required\n${suggestion}`);

      const taskSpec = specParts.join("\n\n");
      const {
        workItem: followUpWi,
        job: devJob,
        payload: suggestionPayload,
      } = createApprovedSuggestionFollowUp({
        sourceWorkItem: wi,
        sourceJobId: jobId,
        artifactId,
        suggestionIndex,
        suggestion,
        taskSpec,
        filesToModify: originalFiles,
        filesToCreate: originalCreateFiles,
        createRoots: originalCreateRoots,
      });

      // Best-effort parity with planner-created dev jobs: write a scoped task.json
      // and thread the context dir into payload so future consumers can rely on it.
      try {
        const jobCtxDir = path.join(contextDir(wiScopeId(followUpWi.id), PROJECT_DIR), `job-${devJob.id}`);
        fs.mkdirSync(jobCtxDir, { recursive: true });
        fs.writeFileSync(path.join(jobCtxDir, "task.json"), JSON.stringify({
          title: devJob.title,
          task_spec: suggestionPayload.task_spec,
          job_type: "dev",
          task_mode: "code",
          files_to_modify: suggestionPayload.files_to_modify,
          files_to_create: suggestionPayload.files_to_create,
          create_roots: suggestionPayload.create_roots,
          success_criteria: suggestionPayload.success_criteria,
        }, null, 2), "utf-8");

        for (const fp of suggestionPayload.files_to_modify) {
          try {
            const src = path.resolve(PROJECT_DIR, fp);
            if (!fs.existsSync(src)) continue;
            const dest = path.join(jobCtxDir, fp);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
          } catch { /* best effort */ }
        }

        updateJobPayload(devJob.id, JSON.stringify({
          ...suggestionPayload,
          context_dir: jobCtxDir.replace(/\\/g, "/"),
        }));
      } catch { /* context dir is helpful, not required */ }

      approvedCount++;
      console.log(`    ${C.green}+ Queued WI#${followUpWi.id} dev #${devJob.id}${C.reset}\n`);

      const decisionJson = suggestionDecisionEventJson({
        artifactId,
        suggestionIndex,
        suggestion,
        decision: "approved",
        targetWorkItemId: followUpWi.id,
        targetJobId: devJob.id,
      });

      logEvent({
        work_item_id: wi.id,
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_SUGGESTION_APPROVED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Approved suggestion -> WI#${followUpWi.id} dev #${devJob.id}: ${suggestion.slice(0, 60)}`,
        event_json: JSON.stringify(decisionJson),
      });
      logEvent({
        work_item_id: followUpWi.id,
        job_id: devJob.id,
        event_type: EVENT_TYPES.WORK_ITEM_CREATED_FROM_SUGGESTION,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Created from WI#${wi.id} suggestion ${suggestionKey}`,
        event_json: JSON.stringify(decisionJson),
      });
    } else if (c === "r") {
      console.log(`    ${C.dim}Skipping remaining suggestions.${C.reset}\n`);
      break;
    } else if (c === "s") {
      logEvent({
        work_item_id: wi.id,
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_SUGGESTION_SKIPPED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Skipped suggestion: ${suggestion.slice(0, 80)}`,
        event_json: JSON.stringify(suggestionDecisionEventJson({
          artifactId,
          suggestionIndex,
          suggestion,
          decision: "skipped",
          reason: "human_skip",
        })),
      });
      console.log("");
    }
  }

  if (approvedCount > 0) {
    console.log(`  ${C.green}${approvedCount} suggestion(s) approved -> queued as follow-up work items${C.reset}`);
    console.log(`  ${C.dim}Run 'posse run' to execute them.${C.reset}\n`);
  }

  return approvedCount;

  }

  async wrapUpTui(display) {
    const {
      autoMergeCompletedWorkItems,
      listWorkItems,
      isReviewableWorkItem,
      NO_TUI,
      Display,
      cmdDashboard,
      C,
      listJobsByWorkItem,
      ask,
      updateWorkItemStatus,
      logEvent,
      gitMergeToTarget,
      PROJECT_DIR,
      execSync,
      TARGET_BRANCH,
      setMergeState,
      cleanupWiBranch,
      requeueWorkItemAfterRejection,
      offerPush,
      ensureCleanTargetBranch,
      cleanupRunningAgentCalls,
      listJobs,
      notifyDirtyState,
      processIterativeWrapUp,
      mergeIterativePassToTarget,
      saveReportFromModule,
      listReviewableWorkItemsForApprovalFromModule,
      buildReviewReportDataFromModule,
      gitDiffStat,
      getJobWriteScope,
      findWriteLockConflict,
      getWorkItem,
      getIterativeState,
      collectHandledSuggestionKeys,
      getEventsByWorkItem,
      getArtifactsByWorkItem,
      suggestionReviewKey,
      getJob,
      suggestionDevJobDecision,
      suggestionDecisionEventJson,
      getArtifacts,
      createApprovedSuggestionFollowUp,
      path,
      contextDir,
      wiScopeId,
      fs,
      updateJobPayload,
    } = this;

  const wrapUp = createTuiWrapUpTracker(display, {
    title: "Run wrap-up",
    subtitle: "Still winding down. Please wait before exiting.",
    steps: [
      { id: "agents", label: "Settle agent call state" },
      { id: "iterate", label: "Process iterative follow-ups" },
      { id: "target", label: "Check target branch" },
      { id: "auto-merge", label: "Auto-merge completed work items" },
      { id: "review-data", label: "Check manual review items" },
      { id: "review-report", label: "Build review reports" },
    ],
  });

  // Clean up any agent calls left in 'running' state from killed/crashed workers
  await wrapUp.run("agents", () => cleanupRunningAgentCalls());
  const iterateResult = await wrapUp.run("iterate", () => processIterativeWrapUp({
    display,
    reason: "TUI wrap-up",
    mergeIterativePassToTarget,
  }), {
    doneDetail: (result) => result?.rerun ? `${result.spawned || 0} next pass${result.spawned === 1 ? "" : "es"}` : "",
  });
  if (iterateResult.rerun) {
    display.addEvent(`${C.cyan}[iterate]${C.reset} Continuing with the next iterative pass...`);
    await new Promise(r => setTimeout(r, this.iterativeRerunDelayMs ?? 1200));
    wrapUp.clear();
    return iterateResult;
  }

  // Surface dirty-target before auto-merge: it's the #1 silent killer of every
  // batched merge, and the user can fix it from inside the review TUI with [t].
  const targetDirtyAtWrapUp = await wrapUp.run("target", () => this._announceDirtyTargetBeforeAutoMerge(display), {
    doneDetail: (dirty) => dirty ? "dirty" : "clean",
  });

  const autoMergedNow = await wrapUp.run("auto-merge", async () => {
    const outcome = await withMergeLock(() => autoMergeCompletedWorkItems({ display, reason: "TUI wrap-up" }));
    if (!outcome.acquired) {
      display.addEvent(`${C.yellow}Auto-merge skipped: another merge is already in progress.${C.reset}`);
      return 0;
    }
    return outcome.result;
  }, {
    doneDetail: (count) => count > 0 ? `${count} merged` : "none",
  });
  const mergeFailures = this._listMergeFailedAfterAutoMerge();
  if (mergeFailures.length > 0) {
    display.addEvent(`${C.red}${C.bold}⚠ ${mergeFailures.length} work item(s) failed to auto-merge — opening review${C.reset}`);
  }

  // Build report data for each reviewable work item. Research-only and other
  // non-writing work stays in the admin/event logs, not the approval queue.
  const reviewable = await wrapUp.run("review-data", () => listWorkItems(["complete", "failed"])
    .filter(isReviewableWorkItem), {
    doneDetail: (items) => items.length > 0 ? `${items.length} item${items.length === 1 ? "" : "s"}` : "none",
  });
  // Count auto-merged WIs (complete, no branch, had dev/fix jobs = auto-approved+merged)

  if (reviewable.length === 0) {
    if (targetDirtyAtWrapUp) {
      display.addEvent(`${C.red || ""}Target branch still has uncommitted changes; resolve them before relying on auto-merge or push.${C.reset || ""}`);
      if (typeof display.setRunPhase === "function") display.setRunPhase("Target branch needs cleanup");
      await new Promise(r => setTimeout(r, this.emptyReviewPauseMs ?? 1500));
      wrapUp.clear();
      display.stop();
      await notifyDirtyState();
      return iterateResult;
    }
    if (autoMergedNow > 0) {
      display.addEvent(`${C.dim}All work items auto-approved and merged.${C.reset}`);
      if (typeof display.setRunPhase === "function") {
        display.setRunPhase(`Ready to push ${autoMergedNow} merged work item${autoMergedNow === 1 ? "" : "s"}`);
      }
      await new Promise(r => setTimeout(r, 1500));
      wrapUp.clear();
      display.stop();
      await notifyDirtyState();
      await offerPush(autoMergedNow);
    } else {
      display.addEvent(`${C.dim}No work items to review.${C.reset}`);
      if (typeof display.setRunPhase === "function") display.setRunPhase("Wrap-up complete");
      await new Promise(r => setTimeout(r, 1500));
      wrapUp.clear();
      display.stop();
      await notifyDirtyState();
    }
    return;
  }

  const reportData = await wrapUp.run("review-report", () => this.buildReviewReportDataAsync(reviewable), {
    doneDetail: (items) => `${items.length} report${items.length === 1 ? "" : "s"}`,
  });
  wrapUp.clear();
  this.installApprovalActions(display, reportData);

  // Classify: defensive fallback for legacy report data that may still include
  // non-writing items. Normal approval queues should already exclude them.
  for (const item of reportData) {
    const hadWriteJob = item.jobs.some(jobIsWriteStep);
    item._isInfo = !hadWriteJob;
    if (item._isInfo) {
      item._decision = "info"; // auto-acknowledged
    }
  }

  // Start on the first actionable (non-info) item
  const firstActionable = reportData.findIndex(d => !d._isInfo);

  // Enter approval mode and wait for user to finish reviewing
  await display.enterApprovalMode(reportData, firstActionable >= 0 ? firstActionable : 0);

  // Drain any pending git work queued from approve/reject/delete keystrokes.
  // The keypress handler returns immediately after queuing, so merges may
  // still be running when enterApprovalMode resolves. Without this await,
  // the display would tear down mid-merge and the user would see a blank
  // screen while git finishes.
  const closeout = createTuiWrapUpTracker(display, {
    title: "Review closeout",
    subtitle: "Finishing review work before leaving the TUI.",
    steps: [
      { id: "git", label: "Finish queued git work" },
      { id: "report", label: "Save review report" },
      { id: "terminal", label: "Prepare terminal prompts" },
    ],
  });
  try {
    await closeout.run("git", async () => {
      try {
        if (typeof display._mergeQueuePromise === "function") {
          await display._mergeQueuePromise();
        }
      } catch {
        // Queue errors are already captured into item._mergeResult.
      }
    });
    await closeout.run("report", () => this.saveReport(reportData));
    await closeout.run("terminal", () => {
      display._mode = "normal";
      display._approvalData = [];
      display._approvalDone = null;
      display.requestRender?.({ force: true });
    });
  } finally {
    if (typeof display._mode === "string" && display._mode !== "normal") {
      display._mode = "normal";
    }
    closeout.clear();
  }

  // ── Offer to push if anything was merged (manual approvals + auto-merges) ──
  const approved = reportData.filter(d => d._decision === "approved").length;
  const totalMerged = approved + autoMergedNow;

  // Ensure TUI is off before interactive prompts (idempotent — stop() is a no-op if already stopped)
  display.stop();

  // Notify about dirty worktrees/branches before push decisions
  await notifyDirtyState();

  if (totalMerged > 0) {
    await offerPush(totalMerged);
  }

  // ── Review assessor suggestions ──
  await this.reviewSuggestions();
  await (this.ensureCleanTargetBranchAsync || ensureCleanTargetBranch)("run wrap-up", { logWhenClean: true });
  return iterateResult;

  }
}
