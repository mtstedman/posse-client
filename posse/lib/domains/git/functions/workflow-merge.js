import { recordTargetDebt, resolveTargetDebtEntries } from "./merge-target-debt-store.js";
export { recordTargetDebt } from "./merge-target-debt-store.js";
import { mergeTestWaiverCovers } from "./merge-test-waiver.js";
// lib/domains/git/functions/workflow-merge.js
// Merge workflow helpers for WI branches and target branch advancement.

import fs from "fs";
import os from "os";
import path from "path";
import { finalizeApprovedWorkItemMerge, getSetting, getWorkItem, getWorkItemMergeDependencies, listJobsByWorkItem, listWorkItems, listCrossWiMergeBlockers, logEvent, mergeVerificationDebtWaiver, mergeVerificationDebtWaiverCovers, currentMergeVerificationApproval, rebindMergeVerificationReviewAfterRefresh, updateWorkItemMetadata } from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import "./hooks.js";
import { warmAtlasMergedToMainNow } from "../../integrations/functions/atlas.js";
import { emitEmbeddingsResume as emitAtlasV2EmbeddingsResume, emitMainAdvanced as emitAtlasV2MainAdvanced, emitMergedToMain as emitAtlasV2MergedToMain, isAtlasV2EmissionEnabled } from "../../atlas/classes/v2/PipelineHooks.js";
import { GIT_OPERATION_TIMEOUT_MS } from "./utils.js";
import { findLegacyWorktreeForWi as nativeFindLegacyWorktreeForWi, preserveDirtyWorktreeSnapshot as nativePreserveDirtyWorktreeSnapshot, worktreePath as nativeWorktreePath, withWorktreeLock as nativeWithWorktreeLock } from "./worktree.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { GIT_WORKFLOW_TASK_TIMEOUT_MS } from "./workflow-context.js";
import { GIT_MERGE_TIMEOUT_MS, timedOutMergeCommitLanded } from "./workflow-git-utils.js";
import { DETERMINISTIC_MERGE_FAILURE_KEY, mergeFailureHeadsUnchanged, mergeConflictSummary, resolveHandoffSquashConflicts } from "./handoff-conflict-resolution.js";
import { CLOSEOUT_TEST_TIMEOUT_MS, closeoutTestCommandFromJobs, droppableHandoffSyncJobIds, refreshBranchForCloseout, runCloseoutTestCommandSync } from "./merge-closeout.js";
import { conflictFilesFromMergeError, parkedMergeGuidance } from "./merge-park-guidance.js";
import { mergeCandidateRegisteredTests, registryMergeCheckFailureKind, runRegisteredTest, runRegisteredTestsForMergeCandidate } from "../../../shared/tools/functions/toolkit/registered-tests.js";
import { declaredMergeCandidateCommands, runDeclaredMergeCandidateChecks, withTemporaryMergeCandidateCheckout } from "./merge-candidate-checks.js";
import { classifyMergeTargetDebt, classifyUnavailableMergeCheck, mergeCheckFailureFingerprint } from "./merge-target-debt.js";
import { boundMergeGateEvidence, mergeGateOutputTail } from "./merge-failure-diagnostics.js";
import { MERGE_CLOSEOUT_WORKTREE_PREFIX, MERGE_GATE_STORED_RESULTS, MERGE_GATE_TASK_RESERVE_MS, MERGE_GATE_WALL_BUDGET_MS, MERGE_TARGET_COMPARISON_OUTCOMES, MERGE_TARGET_DEBT_OUTCOMES, MERGE_TARGET_PROCEEDING_OUTCOMES } from "../../../catalog/verification.js";
import { readMergeInProgressMarker, recoverInterruptedSquash as recoverInterruptedSquashIn, removeMergeInProgressMarker, writeMergeInProgressMarker } from "./merge-interrupted-squash.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { passingReceiptCommits, postChangeReceiptsAtCommit } from "../../queue/functions/verification-receipts.js";
import { mergeToSharedTrunkAsync } from "./shared-trunk.js";
import { SHARED_TRUNK_SESSION_USER_TRAILER } from "../../../catalog/shared-trunk.js";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { filterPosseRuntimePaths } from "../../runtime/functions/ignore.js";
import { isAbortError } from "../../runtime/functions/yield.js";
import { recordReviewedSourceMerge, reviewedSourceMergeTrailer } from "./reviewed-source-merge.js";

function reservedRuntimeMergeError(paths = []) {
  const blocked = filterPosseRuntimePaths(paths);
  const error = new Error(
    `Merge candidate contains reserved Posse runtime path(s): ${blocked.slice(0, 10).join(", ")}. Remove them from the source branch before retrying.`,
  );
  error.code = "GIT_RESERVED_RUNTIME_PATH";
  error.runtimePaths = blocked;
  return error;
}



export function createMergeWorkflowHelpers(context, {
  ensureCleanTargetBranch,
  isRuntimePorcelainLine,
  sourceWorktreeDirtyState,
  sweepOrphanedInferTsconfig,
  validatePushCandidateAsync = async () => ({ ok: true }),
  runCloseoutTestCommand = runCloseoutTestCommandSync,
}) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread, gitExec, gitExecAsync } = context;
  const withWorktreeLock = context.withWorktreeLock || nativeWithWorktreeLock;
  const preserveDirtyWorktreeSnapshot = context.preserveDirtyWorktreeSnapshot || nativePreserveDirtyWorktreeSnapshot;
  const canonicalWorktreePath = context.worktreePath || nativeWorktreePath;
  const findLegacyWorktreeForWi = context.findLegacyWorktree || nativeFindLegacyWorktreeForWi;

  function gitDiffStat(mergeBase, branch, cwd) {
    try {
      const raw = gitExec(["diff", "--stat", `${mergeBase}...${branch}`], cwd, { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      return raw.trim().split("\n").filter(l => l.trim());
    } catch {
      return [];
    }
  }

  function gitDiffStatAsync(mergeBase, branch, cwd = projectDir, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("gitDiffStat", { mergeBase, branch, cwd }, workerOptions);
  }

  /**
   * Merge a WI branch into the explicit target branch (master/main).
   * Checks out the target branch first, stashing any uncommitted changes.
   */

  function gitMergeExec(args, cwd, { trim = true } = {}) {
    return gitExec(args, cwd, { timeoutMs: GIT_MERGE_TIMEOUT_MS, trim });
  }

  function gitMergeExecAsync(args, cwd, { trim = true } = {}) {
    return gitExecAsync(args, cwd, { timeoutMs: GIT_MERGE_TIMEOUT_MS, trim });
  }

  function firstGitLine(err) {
    return String(err?.stderr || err?.stdout || err?.message || err || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0] || "unknown git error";
  }

  function isGitTimeoutError(err) {
    const text = String([
      err?.code,
      err?.signal,
      err?.message,
      err?.stderr,
      err?.stdout,
    ].filter(Boolean).join("\n"));
    return err?.code === "ETIMEDOUT" || /ETIMEDOUT|timed out|timeout/i.test(text);
  }

  function expectedSquashSubject(branch, mergeTargetBranch = currentTargetBranch()) {
    const targetBranch = mergeTargetBranch;
    return `Squash merge ${branch} into ${targetBranch}`;
  }

  async function canonicalSquashMergeEvidence(workItem, cwd = projectDir, {
    targetBranch = currentTargetBranch(),
  } = {}) {
    const branch = String(workItem?.branch_name || "").trim();
    const mergeBase = String(workItem?.merge_base_hash || "").trim();
    if (!branch || branch === targetBranch || !/^[0-9a-f]{40}$/i.test(mergeBase)) return null;
    const updatedAtMs = Date.parse(String(workItem?.updated_at || ""));
    if (!Number.isFinite(updatedAtMs)) return null;
    let rows;
    try {
      rows = await gitMergeExecAsync([
        "log",
        "--format=%H%x09%ct%x09%s",
        `${mergeBase}..${targetBranch}`,
      ], cwd);
    } catch {
      return null;
    }
    const expectedSubject = expectedSquashSubject(branch, targetBranch);
    for (const row of rows.split("\n")) {
      const [mergeHash = "", committedAt = "", ...subjectParts] = row.split("\t");
      if (subjectParts.join("\t") !== expectedSubject || !/^[0-9a-f]{40}$/i.test(mergeHash)) continue;
      const committedAtMs = Number(committedAt) * 1000;
      // Git commit timestamps have one-second precision while SQLite rows have
      // millisecond precision. Permit only that truncation window; an older
      // canonical commit must not re-close a work item that was later reopened.
      if (!Number.isFinite(committedAtMs) || committedAtMs + 999 < updatedAtMs) continue;
      return { mergeHash, targetBranch, branch };
    }
    return null;
  }

  async function reconcileCanonicalSquashMergeWorkItems(cwd = projectDir) {
    const targetBranch = currentTargetBranch();
    const result = { reconciled: 0, inspected: 0, failures: [] };
    for (const workItem of listWorkItems(["complete", "failed"])) {
      if (!workItem?.branch_name || workItem.merge_state === "merged") continue;
      result.inspected += 1;
      const evidence = await canonicalSquashMergeEvidence(workItem, cwd, { targetBranch });
      if (!evidence) continue;
      try {
        recordReviewedSourceMerge({ workItemId: workItem.id, mergeHash: evidence.mergeHash, cwd, git: gitMergeExec });
        const settled = finalizeApprovedWorkItemMerge(workItem.id);
        if (!settled?.ok) {
          result.failures.push({ work_item_id: workItem.id, reason: settled?.reason || "queue_settlement_failed" });
          continue;
        }
        logEvent({
          work_item_id: workItem.id,
          event_type: EVENT_TYPES.WORK_ITEM_MERGED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Recovered canonical squash merge of ${evidence.branch} into ${evidence.targetBranch} at ${evidence.mergeHash}`,
          event_json: JSON.stringify({
            branch: evidence.branch,
            target_branch: evidence.targetBranch,
            merge_hash: evidence.mergeHash,
            recovered: "canonical_squash_commit",
          }),
        });
        result.reconciled += 1;
      } catch (err) {
        result.failures.push({ work_item_id: workItem.id, reason: firstGitLine(err) });
      }
    }
    return result;
  }

  function squashCommitArgs(subject, sharedTrunkOperationId = null, wiId = null, source = null) {
    const args = ["commit", "-m", subject];
    const reviewedSource = reviewedSourceMergeTrailer(wiId, source?.sourceHead);
    if (reviewedSource) args.push("-m", reviewedSource);
    if (source) {
      // Keep the recovery subject stable, but preserve the work's descriptive
      // commit subjects in the squash body instead of losing them on main.
      const subjects = gitMergeExec(["log", "--no-merges", "--format=%s", "--max-count=50",
        `${source.targetBranch}..${source.branch}`, "--"], source.cwd);
      if (subjects.trim()) {
        const changes = subjects.slice(0, 12000).split("\n").filter(Boolean).map((line) => `- ${line}`).join("\n");
        args.push("-m", `Included changes:\n${changes}`);
      }
    }
    if (sharedTrunkOperationId) {
      args.push("-m", `Posse-Shared-Trunk-Operation: ${sharedTrunkOperationId}`);
      const session = getLivePairingState();
      if (session?.phase === "active" && session.shared_branch === (source?.targetBranch || currentTargetBranch())) {
        if (!session.remote_session_id || !session.instance_id) {
          throw Object.assign(new Error("Active session commit identity is incomplete"), {
            code: "session_commit_identity_unavailable",
          });
        }
        args.push("-m", `${SHARED_TRUNK_SESSION_USER_TRAILER}: ${session.remote_session_id}:${session.instance_id}`);
      }
    }
    const delegation = workItemMetadata(wiId)?.session_delegation;
    if (delegation?.originator_instance_id && Number.isSafeInteger(Number(delegation.origin_work_item_id))) {
      args.push(
        "-m",
        `Posse-Origin-Work-Item: ${String(delegation.originator_instance_id).slice(0, 128)}:${Number(delegation.origin_work_item_id)}`,
      );
    }
    return args;
  }

  function workItemMetadata(wiId) {
    if (wiId == null) return {};
    try {
      const parsed = JSON.parse(getWorkItem(wiId)?.metadata_json || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function mergeHeads(branch, targetBranch, cwd) {
    try {
      return {
        branchHead: gitMergeExec(["rev-parse", branch], cwd),
        targetHead: gitMergeExec(["rev-parse", targetBranch], cwd),
      };
    } catch {
      return { branchHead: null, targetHead: null };
    }
  }

  function recordDeterministicMergeFailure(wiId, branch, targetBranch, heads, error, files = []) {
    if (wiId == null || !heads?.branchHead || !heads?.targetHead) return;
    const metadata = workItemMetadata(wiId);
    metadata[DETERMINISTIC_MERGE_FAILURE_KEY] = {
      branch,
      target_branch: targetBranch,
      branch_head: heads.branchHead,
      target_head: heads.targetHead,
      error: String(error || "").slice(0, 1000),
      files: (Array.isArray(files) ? files : []).slice(0, 50),
      recorded_at: new Date().toISOString(),
    };
    updateWorkItemMetadata(wiId, metadata);
  }

  function clearDeterministicMergeFailure(wiId) {
    if (wiId == null) return;
    const metadata = workItemMetadata(wiId);
    if (!Object.prototype.hasOwnProperty.call(metadata, DETERMINISTIC_MERGE_FAILURE_KEY)) return;
    delete metadata[DETERMINISTIC_MERGE_FAILURE_KEY];
    updateWorkItemMetadata(wiId, metadata);
  }

  // After the merge commit: a failure merged under a waiver, or a check
  // unavailable on the target too, is recorded on this work item at its merge
  // commit (the push offer warns about it); a check that passed clears earlier
  // entries for the same command.
  function recordMergeGateOutcome({ wiId, mergeHash, targetBranch, outcome }) {
    if (!outcome || wiId == null || !/^[0-9a-f]{40}$/i.test(String(mergeHash || ""))) return;
    try {
      for (const result of [...outcome.waived, ...outcome.unavailable]) {
        const classification = result.target_debt_classification;
        const waivedResult = outcome.waived.includes(result);
        const record = recordTargetDebt(wiId, {
          command: String(result.test?.name || result.test?.id || ""),
          cwd_relative: result.cwd_relative || null,
          failure_fingerprint: result.status === "unavailable" ? null : mergeCheckFailureFingerprint(result),
          commit: mergeHash,
          target_branch: targetBranch,
          outcome: classification?.outcome || MERGE_TARGET_COMPARISON_OUTCOMES.UNVERIFIED,
          blocked_work_item_ids: [],
          ...(waivedResult ? { waived_by_gate: outcome.waivedByGate } : {}),
        });
        if (!record) continue;
        logEvent({ work_item_id: wiId, event_type: EVENT_TYPES.WORK_ITEM_TARGET_DEBT_INTRODUCED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: waivedResult
            ? `${record.command} ${record.outcome} merged into ${targetBranch} under waiver gate #${outcome.waivedByGate ?? "unknown"}`
            : `${record.command} merged into ${targetBranch} unverified: unavailable on the target too`,
          event_json: JSON.stringify(record) });
      }
      for (const result of outcome.passed) {
        const command = String(result.test?.name || result.test?.id || "");
        if (!command) continue;
        const resolved = resolveTargetDebtEntries({ command, cwdRelative: result.cwd_relative || null, workItemId: wiId, mergeHash });
        if (resolved.length > 0) {
          logEvent({ work_item_id: wiId, event_type: EVENT_TYPES.GIT_MERGE_TARGET_DEBT, actor_type: EVENT_ACTORS.SYSTEM,
            message: `${command} passed in the merge of WI#${wiId}; resolved ${resolved.length} recorded ${targetBranch} debt entr${resolved.length === 1 ? "y" : "ies"}`,
            event_json: JSON.stringify({ resolved_by: { work_item_id: wiId, commit: mergeHash }, resolved }) });
        }
      }
    } catch (error) {
      // The merge already landed; the evidence record is best effort.
      try {
        logEvent({ work_item_id: wiId, event_type: EVENT_TYPES.GIT_MERGE, actor_type: EVENT_ACTORS.SYSTEM,
          message: `Recording merge gate evidence for WI#${wiId} failed: ${error?.message || error}`,
          event_json: JSON.stringify({ merge_hash: mergeHash }) });
      } catch { /* observational */ }
    }
  }

  function branchCheckoutPaths(branch, cwd) {
    try {
      const listing = gitMergeExec(["worktree", "list", "--porcelain"], cwd, { trim: false });
      const paths = [];
      let current = null;
      for (const line of String(listing || "").split("\n")) {
        if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
        else if (current && line.trim() === `branch refs/heads/${branch}`) paths.push(path.resolve(current));
      }
      return paths;
    } catch {
      return null;
    }
  }

  function workItemWorktreeDir(wiId) {
    const canonical = canonicalWorktreePath(projectDir, wiId);
    if (fs.existsSync(canonical)) return canonical;
    const legacy = findLegacyWorktreeForWi(projectDir, wiId);
    return legacy && fs.existsSync(legacy) ? legacy : null;
  }

  function parkGuidance(wiId, branch, targetBranch, files) {
    let worktreePath = null;
    try {
      worktreePath = wiId == null ? null : workItemWorktreeDir(wiId);
    } catch {
      worktreePath = null;
    }
    return parkedMergeGuidance({ wiId, branch, targetBranch, files, worktreePath });
  }

  // Close-out: before the squash merge, replay the work item's own commits
  // onto the current target (dropping handoff copies whose source merged) and
  // resolve only ordering-induced conflicts. Returns { refreshed, reason } to
  // continue, or { park } with the merge result when the work item must wait
  // for manual review.
  function runCloseoutRefresh({ wiId, branch, targetBranch, cwd, sourceDirty, log, deadlineMs = Infinity, approval = null }) {
    if (wiId == null) return { refreshed: false, reason: "not_a_work_item_merge" };
    try {
      if (gitMergeExec(["merge-base", targetBranch, branch], cwd) === gitMergeExec(["rev-parse", targetBranch], cwd)) {
        return { refreshed: false, reason: "branch_already_on_target" };
      }
    } catch (error) {
      return { refreshed: false, reason: `closeout_scan_failed: ${firstGitLine(error)}` };
    }
    const skip = (reason) => {
      // A refresh that cannot run safely is not a merge blocker: the plain
      // squash merge below runs from the target checkout and the handoff
      // union fallback still applies.
      log(`Close-out refresh skipped for ${branch} (${reason}); continuing with the plain squash merge`, {
        json: { branch, target: targetBranch, closeout_skipped: true, reason },
      });
      return { refreshed: false, reason };
    };

    const dependencies = getWorkItemMergeDependencies(wiId)
      .map((dependency) => ({ ...dependency, source: getWorkItem(dependency.source_work_item_id) }));
    let testCommand = null;
    try {
      testCommand = closeoutTestCommandFromJobs(listJobsByWorkItem(wiId));
    } catch {
      testCommand = null;
    }
    const checkedOut = branchCheckoutPaths(branch, cwd);
    if (checkedOut == null) return skip("worktree_listing_failed");
    const ownWorktree = workItemWorktreeDir(wiId);
    let worktreePath;
    let ownsWorktree = false;
    if (ownWorktree && checkedOut.includes(path.resolve(ownWorktree))) {
      if (sourceDirty && sourceDirty.untrackedFiles.length > 0) return skip("work_item_worktree_has_untracked_leftovers");
      worktreePath = ownWorktree;
    } else if (checkedOut.length > 0) {
      return skip("branch_checked_out_elsewhere");
    } else {
      worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), MERGE_CLOSEOUT_WORKTREE_PREFIX));
      try {
        gitMergeExec(["worktree", "add", "--detach", worktreePath, branch], cwd);
        ownsWorktree = true;
      } catch (error) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        return skip(`closeout_worktree_add_failed: ${firstGitLine(error)}`);
      }
    }

    // The close-out test shares the merge worker's deadline with the gate. A
    // test cut short by that budget proves nothing about the resolution, so it
    // skips the refresh instead of parking the work item as a conflict.
    let testBudgetExpired = false;
    const runBoundedTestCommand = (command, options = {}) => {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs < 1000) {
        testBudgetExpired = true;
        return { ok: false, status: null, timed_out: true, output: "merge task budget expired before the close-out test" };
      }
      const bounded = remainingMs < CLOSEOUT_TEST_TIMEOUT_MS;
      const outcome = runCloseoutTestCommand(command, {
        ...options,
        ...(bounded ? { timeoutMs: Math.floor(remainingMs) } : {}),
      });
      if (bounded && !outcome?.ok && outcome?.timed_out) testBudgetExpired = true;
      return outcome;
    };
    let result;
    try {
      result = refreshBranchForCloseout({
        exec: gitMergeExec,
        cwd,
        branch,
        targetBranch,
        worktreePath,
        ownsWorktree,
        droppableSyncJobIds: droppableHandoffSyncJobIds(dependencies),
        testCommand,
        runTestCommand: runBoundedTestCommand,
        isIgnorableStatusLine: (line) => isRuntimePorcelainLine(line, worktreePath),
      });
    } finally {
      if (ownsWorktree) {
        try { gitMergeExec(["worktree", "remove", "--force", worktreePath], cwd); } catch { /* pruned below */ }
        fs.rmSync(worktreePath, { recursive: true, force: true });
        try { gitMergeExec(["worktree", "prune"], cwd); } catch { /* best effort */ }
      }
    }

    const detail = {
      branch,
      target: targetBranch,
      old_head: result.branchHead || null,
      target_head: result.targetHead || null,
      private_worktree: ownsWorktree,
    };
    if (result.refreshed) {
      const restoredNote = [
        result.restoredFiles?.length > 0
          ? `; restored work committed inside merges in ${result.restoredFiles.join(", ")}`
          : "",
        result.threeWayMergedFiles?.length > 0
          ? `; 3-way merged work committed inside merges with later target changes in ${result.threeWayMergedFiles.join(", ")}`
          : "",
      ].join("");
      // Replaying the reviewed commits without resolving or merging content
      // keeps the reviewed change: carry an operator approval to the new head.
      // Restored files take the reviewed head's own content.
      const contentPreserving = (result.resolvedFiles?.length || 0) === 0
        && (result.threeWayMergedFiles?.length || 0) === 0;
      const reviewRebind = !approval ? null
        : contentPreserving
          ? rebindMergeVerificationReviewAfterRefresh(wiId, {
            gateJobId: approval.gate_job_id,
            fromHead: result.branchHead,
            toHead: result.refreshedHead,
            targetHead: result.targetHead,
          })
          : { ok: false, reason: "refresh_changed_content" };
      log(`Close-out refreshed ${branch} onto ${targetBranch}${result.resolvedFiles.length > 0 ? `; resolved ordering conflicts in ${result.resolvedFiles.join(", ")}` : ""}${restoredNote}${reviewRebind?.ok ? `; merge review gate #${approval.gate_job_id} rebound to the refreshed head` : ""}`, {
        json: {
          ...detail,
          closeout_refreshed: true,
          refreshed_head: result.refreshedHead,
          dropped_handoff_sync_commits: result.dropped,
          skipped_empty_commits: result.skipped,
          resolved_files: result.resolvedFiles,
          restored_files: result.restoredFiles || [],
          three_way_merged_files: result.threeWayMergedFiles || [],
          resolution_rules: result.rules,
          test_command: result.testCommand,
          content_preserving: contentPreserving,
          merge_review_rebind: reviewRebind,
        },
      });
      return {
        refreshed: true,
        fromHead: result.branchHead,
        refreshedHead: result.refreshedHead,
        targetHead: result.targetHead,
        contentPreserving,
        reviewRebind,
      };
    }
    if (result.testFailed && testBudgetExpired) return skip("closeout_test_budget_expired");
    if (result.testFailed) {
      const message = `Merge parked for manual review: close-out refresh of ${branch} resolved ordering conflicts in ${result.files.join(", ")}, but its test command failed (${result.testCommand})`;
      log(message, { json: { ...detail, closeout_test_failed: true, test_command: result.testCommand, test_output: result.testOutput } });
      recordDeterministicMergeFailure(wiId, branch, targetBranch, {
        branchHead: result.branchHead,
        targetHead: result.targetHead,
      }, message, result.files);
      return {
        refreshed: false,
        reason: "closeout_test_failed",
        park: {
          ok: false,
          deterministicConflict: true,
          closeoutTestFailed: true,
          branchHead: result.branchHead,
          targetHead: result.targetHead,
          conflictFiles: result.files,
          message: `${message}. ${parkGuidance(wiId, branch, targetBranch, result.files)}`,
        },
      };
    }
    if (result.conflict) {
      // Not ordering-induced. The squash merge below may still apply (its
      // net diff can differ from the per-commit replay); if it conflicts, it
      // aborts cleanly and records the deterministic memo as before.
      const reason = `overlapping edit (${result.error})`;
      log(`Close-out refresh of ${branch} stopped at an ${reason}; trying the plain squash merge`, {
        json: { ...detail, closeout_conflict: true, error: result.error, files: result.files, commit: result.commit },
      });
      return { refreshed: false, reason };
    }
    if (result.attempted === false && !result.infrastructureFailure) return { refreshed: false, reason: result.reason };
    return skip(result.reason);
  }

  function emitMergePhase(onPhase, phase, message, data = {}) {
    if (typeof onPhase !== "function") return;
    try { onPhase({ phase, message, ...data }); } catch { /* display callback only */ }
  }

  function gitMergeCommitParent(cwd, mergeHash) {
    if (!mergeHash || mergeHash === "(unknown)") return "";
    try {
      return gitMergeExec(["rev-parse", `${mergeHash}^`], cwd);
    } catch {
      return "";
    }
  }

  function gitMergeCommitChangedPaths(cwd, mergeHash, parentHash = "") {
    if (!mergeHash || mergeHash === "(unknown)") return [];
    const linesFrom = (text) => [...new Set(String(text || "")
      .split("\n")
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter(Boolean))];
    if (parentHash) {
      try {
        return linesFrom(gitMergeExec(["diff", "--name-only", parentHash, mergeHash], cwd, { trim: false }));
      } catch {
        // Fall through to diff-tree below.
      }
    }
    try {
      return linesFrom(gitMergeExec(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", mergeHash], cwd, { trim: false }));
    } catch {
      return [];
    }
  }

  function emitAtlasMainAdvancedAfterMerge({
    wiId = null,
    branchName = null,
    targetBranch = null,
    mergeHash = null,
    cwd = projectDir,
    source = "merge",
  } = {}) {
    if (!mergeHash || mergeHash === "(unknown)") return { attempted: false, skipped: "missing_merge_hash" };
    if (!isAtlasV2EmissionEnabled()) return { attempted: false, skipped: "atlas_v2_emission_disabled" };
    const parentHash = gitMergeCommitParent(cwd, mergeHash);
    const paths = gitMergeCommitChangedPaths(cwd, mergeHash, parentHash);
    const target = String(targetBranch || currentTargetBranch() || "main");
    try {
      const result = emitAtlasV2MainAdvanced({
        payload: {
          from_sha: parentHash,
          to_sha: String(mergeHash),
          target_branch: target,
          paths,
          source,
        },
        jobId: null,
        onError: (err) => logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
          actor_type: EVENT_ACTORS.ATLAS,
          message: `ATLAS main refresh outbox failed after merge of ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
          event_json: JSON.stringify({
            branch: branchName || null,
            target_branch: target,
            merge_hash: mergeHash,
            parent_hash: parentHash || null,
            source,
            error: err?.message || String(err),
          }),
        }),
      });
      return {
        ...result,
        attempted: true,
        parentHash,
        paths,
      };
    } catch (err) {
      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
        actor_type: EVENT_ACTORS.ATLAS,
        message: `ATLAS main refresh outbox failed after merge of ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
        event_json: JSON.stringify({
          branch: branchName || null,
          target_branch: target,
          merge_hash: mergeHash,
          parent_hash: parentHash || null,
          source,
          error: err?.message || String(err),
        }),
      });
      return { attempted: true, ok: false, error: err?.message || String(err) };
    }
  }

  // Non-blocking counterpart of refreshAtlasMainAfterMerge: hand the merge
  // replay to the ATLAS outbox so the background atlas_warm scheduler picks
  // it up (coalescing with any queued main-merge warm for the same branch).
  // Review/approval and wrap-up paths use this so the operator never waits
  // on a reindex; if the session exits first, the queued job persists and
  // runs next session.
  function queueAtlasMainRefreshAfterMerge({
    wiId,
    branchName = null,
    targetBranch = null,
    mergeHash = null,
  } = {}) {
    if (!wiId) return { attempted: false, ok: true, skipped: "missing_work_item_id" };
    if (!isAtlasV2EmissionEnabled()) return { attempted: false, ok: true, skipped: "atlas_v2_emission_disabled" };
    const result = emitAtlasV2MergedToMain({
      payload: {
        wi_id: Number(wiId),
        source_branch: String(branchName || ""),
        target_branch: String(targetBranch || "main"),
        merge_commit_sha: String(mergeHash || ""),
      },
      onError: (err) => logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
        actor_type: EVENT_ACTORS.ATLAS,
        message: `ATLAS merge replay enqueue failed for ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
        event_json: JSON.stringify({
          branch: branchName || null,
          target_branch: targetBranch || null,
          merge_hash: mergeHash || null,
          error: err?.message || String(err),
        }),
      }),
    });
    return { ...result, attempted: true };
  }

  async function refreshAtlasMainAfterMerge({
    wiId,
    branchName,
    targetBranch,
    mergeHash,
    onPhase = null,
    onProgress = null,
    signal = null,
    source = "merge",
  } = {}) {
    if (!wiId || !mergeHash || mergeHash === "(unknown)") return { attempted: false, skipped: "missing_merge_metadata" };
    emitMergePhase(onPhase, "atlas-indexing", `ATLAS finalizing ${branchName || `WI#${wiId}`}`, {
      branch: branchName,
      target: targetBranch,
      mergeHash,
      source,
    });
    const forwardProgress = (event = {}) => {
      try { onProgress?.(event); } catch { /* display callback only */ }
      emitMergePhase(onPhase, "atlas-progress", event.text || event.stage || "ATLAS finalizing", {
        branch: branchName,
        target: targetBranch,
        mergeHash,
        source,
        atlasEvent: event,
      });
    };
    const replay = await warmAtlasMergedToMainNow({
      cwd: projectDir,
      workItemId: wiId,
      targetBranch,
      mergeHash,
      triggerEvent: "atlas.merged_to_main",
      onProgress: forwardProgress,
      signal,
      deferEmbeddings: true,
      flushDeferredEmbeddings: false,
    });
    if (replay.attempted) {
      const result = replay.result || {};
      const eventType = replay.ok === false
        ? (replay.aborted ? EVENT_TYPES.ATLAS_REINDEX_SKIPPED : EVENT_TYPES.ATLAS_REINDEX_FAILED)
        : EVENT_TYPES.ATLAS_WARM_COMPLETED;
      logEvent({
        work_item_id: wiId,
        event_type: eventType,
        actor_type: EVENT_ACTORS.ATLAS,
        message: replay.ok === false
          ? (replay.aborted
            ? `ATLAS merge warm deferred for ${branchName || `WI#${wiId}`}: operator exited wrap-up early`
            : `ATLAS merge warm failed for ${branchName || `WI#${wiId}`}: ${replay.error || "unknown error"}`)
          : result.embeddings_deferred === true
            ? `ATLAS warm (main-merge) completed; embeddings queued: considered=${result.paths_considered ?? 0} branch=${targetBranch}`
            : `ATLAS warm (main-merge) completed: considered=${result.paths_considered ?? 0} branch=${targetBranch}`,
        event_json: JSON.stringify({
          purpose: "main-merge",
          branch: targetBranch,
          source_branch: replay.sourceBranch || null,
          merge_hash: mergeHash,
          backend: replay.backend || "atlas-v2",
          trigger_event: "atlas.merged_to_main",
          source,
          ok: replay.ok !== false,
          skipped: replay.skipped || null,
          error: replay.error || null,
          result,
        }),
      });
      if (replay.ok !== false && result.embeddings_deferred === true && isAtlasV2EmissionEnabled()) {
        try {
          emitAtlasV2EmbeddingsResume({
            payload: {
              target_branch: String(targetBranch || "main"),
              reason: "main_merge_deferred",
            },
            jobId: null,
          });
        } catch { /* best effort; boot readiness can rediscover the gap */ }
      }
    }
    if (replay.ok === false || replay.skipped === "source_branch_missing") {
      queueAtlasMainRefreshAfterMerge({ wiId, branchName, targetBranch, mergeHash });
    }
    return replay;
  }

  function parseOverwritePaths(err) {
    const text = String(err?.stderr || err?.stdout || err?.message || err || "");
    const paths = [];
    let collecting = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!collecting && /untracked working tree files would be overwritten by \S+/i.test(trimmed)) {
        collecting = true;
        continue;
      }
      if (!collecting) continue;
      if (!trimmed) continue;
      if (/^(?:Please|Aborting|error:|fatal:|Resolve conflicts manually|hint:)\b/i.test(trimmed)) break;
      paths.push(trimmed.replace(/^"|"$/g, "").replace(/\\/g, "/"));
    }
    return [...new Set(paths)].filter(Boolean);
  }

  // Backward-compatible alias; both checkout- and merge-blocked errors use
  // the same "untracked working tree files would be overwritten by <op>"
  // template, so a single parser handles both.
  const parseCheckoutOverwritePaths = parseOverwritePaths;

  function snapshotLabel(snapshotRef) {
    return snapshotRef?.refName || snapshotRef?.snapshotPath || String(snapshotRef || "");
  }

  function cleanupSquashMessage(cwd) {
    try {
      const dotGit = gitMergeExec(["rev-parse", "--git-path", "SQUASH_MSG"], cwd);
      const squashPath = path.isAbsolute(dotGit) ? dotGit : path.join(cwd, dotGit);
      if (squashPath && fs.existsSync(squashPath)) fs.rmSync(squashPath, { force: true });
    } catch { /* best effort */ }
  }

  function gitLinesOrNull(args, cwd) {
    try {
      return gitMergeExec(args, cwd)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  function candidateIndexRuntimePaths(cwd) {
    const indexed = gitMergeExec(["-c", "core.quotePath=false", "ls-files", "-z"], cwd, { trim: false });
    return filterPosseRuntimePaths(String(indexed || "").split("\0").filter(Boolean));
  }

  function recoverTimedOutMerge(branch, cwd, log, onPhase = null, {
    step = "unknown",
    targetBranch = currentTargetBranch(),
    preMergeHead = null,
    sharedTrunkOperationId = null,
    wiId = null,
    sourceHead = null,
  } = {}) {
    const canRecover = step === "commit" || step === "postcommit";
    if (!canRecover) return null;

    const subject = expectedSquashSubject(branch, targetBranch);
    const head = (() => {
      try { return gitMergeExec(["rev-parse", "HEAD"], cwd); } catch { return null; }
    })();
    const headSubject = (() => {
      try { return gitMergeExec(["show", "-s", "--format=%s", "HEAD"], cwd); } catch { return ""; }
    })();
    const stagedFiles = gitLinesOrNull(["diff", "--cached", "--name-only"], cwd);
    const unmergedFiles = gitLinesOrNull(["diff", "--name-only", "--diff-filter=U"], cwd);
    if (stagedFiles == null || unmergedFiles == null) {
      return null;
    }

    if (timedOutMergeCommitLanded({
      head,
      preMergeHead,
      headSubject,
      expectedSubject: subject,
      stagedFiles,
      unmergedFiles,
    })) {
      cleanupSquashMessage(cwd);
      log(`Merge timeout recovered: ${branch} commit already landed at ${head}`, {
        json: {
          branch,
          target: targetBranch,
          merge_hash: head,
          timed_out: true,
          timeout_step: step,
          recovered: "commit_already_landed",
        },
      });
      return {
        ok: true,
        timedOut: true,
        recoveredFromTimeout: true,
        mergeHash: head,
        message: `Merged ${branch} into ${targetBranch} (recovered after timeout)`,
        targetBranch,
      };
    }

    if (unmergedFiles.length === 0 && stagedFiles.length > 0) {
      const runtimePaths = candidateIndexRuntimePaths(cwd);
      if (runtimePaths.length > 0) throw reservedRuntimeMergeError(runtimePaths);
      emitMergePhase(onPhase, "retry", `Retrying merge commit for ${branch}`, { branch, target: targetBranch });
      log(`Merge timed out with staged changes; retrying squash merge commit for ${branch}`, {
        json: {
          branch,
          target: targetBranch,
          staged_count: stagedFiles.length,
          staged_files: stagedFiles.slice(0, 50),
          timed_out: true,
          timeout_step: step,
        },
      });
      try {
        emitMergePhase(onPhase, "commit", `Committing squash merge of ${branch}`, { branch, target: targetBranch, retry: true });
        gitMergeExec(squashCommitArgs(subject, sharedTrunkOperationId, wiId, { branch, targetBranch, cwd, sourceHead }), cwd);
        const mergeHash = gitMergeExec(["rev-parse", "HEAD"], cwd);
        cleanupSquashMessage(cwd);
        log(`Merge timeout retry succeeded: ${branch} into ${targetBranch} at ${mergeHash}`, {
          json: {
            branch,
            target: targetBranch,
            merge_hash: mergeHash,
            timed_out: true,
            timeout_step: step,
            recovered: "commit_retry",
          },
        });
        return {
          ok: true,
          timedOut: true,
          recoveredFromTimeout: true,
          mergeHash,
          message: `Merged ${branch} into ${targetBranch} after retry`,
          targetBranch,
        };
      } catch (retryErr) {
        log(`Merge timeout retry failed: ${branch} into ${targetBranch}`, {
          json: {
            branch,
            target: targetBranch,
            error: firstGitLine(retryErr),
            timed_out: true,
            timeout_step: step,
          },
        });
      }
    }

    return null;
  }

  function resolveStashByToken(cwd, token) {
    if (!token) return null;
    let list = "";
    try {
      list = gitMergeExec(["stash", "list", "--format=%H%x00%gd%x00%s"], cwd);
    } catch {
      return null;
    }
    for (const line of list.split("\n")) {
      if (!line) continue;
      const parts = line.split("\0");
      if (parts.length < 3) continue;
      const [hash, ref, subject] = parts;
      if (subject && subject.includes(token)) return { hash, ref, subject };
    }
    return null;
  }

  function dropResolvedAutoStash(cwd, stashState, log) {
    const resolved = resolveStashByToken(cwd, stashState?.token);
    if (!resolved?.ref || resolved.hash !== stashState?.hash) return false;
    try {
      gitMergeExec(["stash", "drop", resolved.ref], cwd);
      return true;
    } catch (err) {
      log(`Auto-stash restored but drop failed; stash left for manual cleanup`, {
        json: {
          stash_ref: resolved.ref,
          stash_hash: resolved.hash,
          error: firstGitLine(err),
        },
      });
      return false;
    }
  }

  function restoreAutoStash(cwd, stashState, log, context) {
    if (!stashState?.hash) return null;
    const restoreBranch = stashState.originalBranch || null;
    try {
      const nowOn = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      if (restoreBranch && nowOn !== restoreBranch) {
        gitMergeExec(["checkout", restoreBranch], cwd);
        log(`Checked out ${restoreBranch} before restoring auto-stashed changes`, {
          json: { from: nowOn, to: restoreBranch, stash_hash: stashState.hash },
        });
      }
    } catch (err) {
      const warning = `Could not return to ${restoreBranch || "original branch"} before restoring auto-stash: ${firstGitLine(err)}`;
      log(warning, { json: { stash_hash: stashState.hash, stash_ref: stashState.ref } });
      return warning;
    }

    try {
      gitMergeExec(["stash", "apply", "--index", stashState.hash], cwd);
      dropResolvedAutoStash(cwd, stashState, log);
      log(`Restored auto-stashed changes after ${context}`, {
        json: {
          stash_hash: stashState.hash,
          original_branch: restoreBranch,
        },
      });
      return null;
    } catch (err) {
      const resolved = resolveStashByToken(cwd, stashState.token);
      const warning = `Auto-stash restore conflicted after ${context}; stash preserved for manual recovery`;
      log(warning, {
        json: {
          stash_ref: resolved?.ref || stashState.ref,
          stash_hash: stashState.hash,
          original_branch: restoreBranch,
          error: firstGitLine(err),
        },
      });
      return `${warning} (${resolved?.ref || stashState.hash})`;
    }
  }

  function gitMergeToTarget(branch, cwd, options = {}) {
    if (options.worktreeLockAlreadyHeld === true) {
      return gitMergeToTargetUnlocked(branch, cwd, options);
    }
    return withWorktreeLock(cwd, projectDir, () => gitMergeToTargetUnlocked(branch, cwd, options));
  }

  function gitMergeToTargetUnlocked(branch, cwd, {
    wiId = null,
    onPhase = null,
    retryDeterministicConflict = false,
    suppressPostMergeEffects = false,
    sharedTrunkOperationId = null,
    testWaiver = null,
    taskDeadlineMs = null,
  } = {}) {
    const targetBranch = currentTargetBranch();
    // The gate and the close-out test end before the worker's own deadline,
    // so a thread timeout never interrupts them with the squash staged.
    const budgetEndMs = Number.isFinite(Number(taskDeadlineMs)) && Number(taskDeadlineMs) > 0
      ? Number(taskDeadlineMs) - MERGE_GATE_TASK_RESERVE_MS
      : Infinity;
    const log = (msg, extra = {}) => {
      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.GIT_MERGE,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: msg,
        event_json: extra.json ? JSON.stringify(extra.json) : undefined,
      });
    };

    if (String(branch || "").trim() === String(targetBranch || "").trim()) {
      const message = `Merge refused: work-item branch ${branch} resolved as its own target; configure or restore the repository trunk before merging`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          self_merge: true,
        },
      });
      return { ok: false, selfMerge: true, message };
    }

    const mergeBlockers = wiId == null ? [] : listCrossWiMergeBlockers(wiId);
    if (mergeBlockers.length > 0) {
      const blockers = mergeBlockers.map((blocker) => {
        const source = blocker.source_work_item;
        const label = source
          ? `WI#${source.id} (${source.status}${source.merge_state ? `/${source.merge_state}` : ""})`
          : `WI#${blocker.source_work_item_id} (missing)`;
        const paths = blocker.paths.length > 0 ? `: ${blocker.paths.join(", ")}` : "";
        return `${label}${paths}`;
      });
      const message = `Merge deferred: WI#${wiId} depends on upstream merge ${blockers.join("; ")}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          deferred: true,
          blockers: mergeBlockers.map((blocker) => ({
            source_work_item_id: blocker.source_work_item_id,
            paths: blocker.paths,
            source_status: blocker.source_work_item?.status || null,
            source_merge_state: blocker.source_work_item?.merge_state || null,
            reason: blocker.reason,
          })),
        },
      });
      return { ok: false, deferred: true, message, blockers: mergeBlockers };
    }

    const initialHeads = mergeHeads(branch, targetBranch, cwd);
    // An operator approval binds the branch commit it reviewed. A branch that
    // moved since needs a fresh review before any refresh or test runs; the
    // auto-merge caller routes reviewStale to that review instead of a
    // merge-failure gate.
    const approval = wiId == null ? null : currentMergeVerificationApproval(wiId);
    const reviewStaleResult = (observedHead, detail) => {
      const short = (sha) => String(sha || "unknown").slice(0, 12);
      const message = `Merge review gate #${approval.gate_job_id} covered branch commit ${short(approval.reviewed_branch_head)}, not ${short(observedHead)}; review the current branch before merging`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          review_stale: true,
          gate_job_id: approval.gate_job_id,
          reviewed_branch_head: approval.reviewed_branch_head || null,
          branch_head: observedHead || null,
          reason: detail,
        },
      });
      return {
        ok: false,
        reviewStale: true,
        gateJobId: approval.gate_job_id,
        branchHead: observedHead || null,
        targetHead: initialHeads.targetHead,
        message,
      };
    };
    if (approval && approval.reviewed_branch_head !== initialHeads.branchHead) {
      return reviewStaleResult(initialHeads.branchHead, "branch_moved_since_review");
    }
    const priorDeterministicFailure = workItemMetadata(wiId)[DETERMINISTIC_MERGE_FAILURE_KEY];
    const unchangedConflictResult = (detail = null) => {
      // A content conflict is a pure function of the two tree heads. A manual
      // approval used to bypass this memo and rerun the identical merge, which
      // could only reproduce the conflict and looked like lock contention.
      // Require the source or target to move before spending another attempt.
      const priorFiles = Array.isArray(priorDeterministicFailure?.files) && priorDeterministicFailure.files.length > 0
        ? priorDeterministicFailure.files
        : conflictFilesFromMergeError(priorDeterministicFailure?.error || "");
      const guidance = parkGuidance(wiId, branch, targetBranch, priorFiles);
      const message = retryDeterministicConflict
        ? `Merge retry blocked: ${branch} and ${targetBranch} have not moved since the prior deterministic conflict${detail ? ` (${detail})` : ""}. ${guidance}`
        : `Merge skipped: ${branch} and ${targetBranch} have not moved since the prior deterministic conflict. ${guidance}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          deterministic_conflict_unchanged: true,
          retry_requested: retryDeterministicConflict,
          branch_head: initialHeads.branchHead,
          target_head: initialHeads.targetHead,
          prior_error: priorDeterministicFailure?.error || null,
          closeout: detail,
        },
      });
      return {
        ok: false,
        deterministicConflict: true,
        unchangedConflict: true,
        retryRequested: retryDeterministicConflict,
        branchHead: initialHeads.branchHead,
        targetHead: initialHeads.targetHead,
        conflictFiles: priorFiles,
        message,
      };
    };
    const memoBlocksSquash = mergeFailureHeadsUnchanged(priorDeterministicFailure, initialHeads);
    // An automatic attempt honours the memo. A re-approval runs the close-out
    // refresh below instead: it can move the branch, which lifts the memo.
    if (memoBlocksSquash && !retryDeterministicConflict) return unchangedConflictResult();

    const sourceDirty = sourceWorktreeDirtyState(wiId);
    if (sourceDirty?.verificationFailed) {
      const message = `Merge refused: could not verify WI#${wiId} worktree state before merging ${branch}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          source_verification_failed: true,
          worktree: sourceDirty.wtDir,
          error: sourceDirty.error || null,
        },
      });
      return {
        ok: false,
        infrastructureFailure: true,
        sourceVerificationFailed: true,
        message,
        wtDir: sourceDirty.wtDir,
      };
    }
    if (sourceDirty && sourceDirty.trackedFiles.length > 0) {
      const message = `Merge refused: WI#${wiId} worktree has ${sourceDirty.trackedFiles.length} unresolved dirty file(s) before merging ${branch}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          source_dirty: true,
          worktree: sourceDirty.wtDir,
          dirty_count: sourceDirty.trackedFiles.length,
          dirty_files: sourceDirty.trackedFiles.slice(0, 50),
          untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
        },
      });
      return {
        ok: false,
        dirty: true,
        sourceDirty: true,
        message,
        wtDir: sourceDirty.wtDir,
        dirtyFiles: sourceDirty.trackedFiles.slice(0, 50),
      };
    }
    if (sourceDirty) {
      // Untracked-only leftovers cannot reach the squash merge — it stages only
      // the branch's commits — so they don't gate it. Post-merge cleanup
      // force-removes the worktree, making the snapshot taken here the only
      // surviving copy; refuse the merge if it cannot be written.
      let snapshotRef = null;
      try {
        snapshotRef = preserveDirtyWorktreeSnapshot(sourceDirty.wtDir, projectDir, {
          reason: "untracked-leftovers",
          branchName: branch,
          wiId,
          onMsg: (msg) => log(msg, { json: { branch, worktree: sourceDirty.wtDir } }),
        });
      } catch {
        snapshotRef = null;
      }
      if (!snapshotRef) {
        const message = `Merge refused: could not snapshot ${sourceDirty.untrackedFiles.length} untracked leftover file(s) in WI#${wiId} worktree before merging ${branch}`;
        log(message, {
          json: {
            branch,
            target: targetBranch,
            source_dirty: true,
            worktree: sourceDirty.wtDir,
            untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
          },
        });
        return {
          ok: false,
          dirty: true,
          sourceDirty: true,
          message,
          wtDir: sourceDirty.wtDir,
          dirtyFiles: sourceDirty.untrackedFiles.slice(0, 50),
        };
      }
      log(`Proceeding with merge of ${branch} despite ${sourceDirty.untrackedFiles.length} untracked leftover file(s) in WI#${wiId} worktree; preserved at ${snapshotRef}`, {
        json: {
          branch,
          target: targetBranch,
          worktree: sourceDirty.wtDir,
          untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
          snapshot_ref: String(snapshotRef),
        },
      });
    }

    const closeout = runCloseoutRefresh({ wiId, branch, targetBranch, cwd, sourceDirty, log, deadlineMs: budgetEndMs, approval });
    if (closeout.park) return closeout.park;
    // A refresh that resolved or merged content changed what the operator
    // reviewed; one that only replayed the reviewed commits was rebound.
    if (approval && closeout.refreshed && !closeout.reviewRebind?.ok) {
      return reviewStaleResult(closeout.refreshedHead, closeout.contentPreserving
        ? `review_rebind_failed: ${closeout.reviewRebind?.reason || "unknown"}`
        : "closeout_refresh_changed_content");
    }
    // A re-approval whose refresh could not move the branch would only rerun
    // the identical conflicting squash merge.
    if (memoBlocksSquash && !closeout.refreshed) {
      return unchangedConflictResult(closeout.reason || "close-out refresh did not change the branch");
    }

    let currentBranch = null;
    let autoStash = null;
    let mergeMarkerWritten = false;

    try {
      // Pre-flight: an earlier merge interrupted mid-gate (thread timeout,
      // crash) left its squash staged and its temporary checkouts registered.
      // Unstage it (a later dirty-tree commit would ship an unverified
      // candidate) and remove the checkouts before anything below reads the
      // tree as dirty.
      const interrupted = recoverInterruptedSquash(cwd, { log });
      if (interrupted.action === "failed") {
        const message = `Merge refused: could not repair the squash an interrupted merge gate left in the target worktree (${interrupted.error}); unstage it before merging ${branch}`;
        log(message, { json: { branch, target: targetBranch, interrupted_merge_recovery: "failed" } });
        return { ok: false, dirty: true, message };
      }

      // Pre-flight: MERGE_HEAD in the target checkout is never Posse's own
      // state — every Posse merge here is `merge --squash`, which does not
      // write MERGE_HEAD under any failure mode. Aborting it would discard a
      // human's in-progress merge resolution, so refuse like the dirty gate.
      let hasMergeHead = false;
      try {
        gitMergeExec(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
        hasMergeHead = true;
      } catch {
        hasMergeHead = false;
      }
      if (hasMergeHead) {
        const message = `Merge refused: target worktree has an in-progress merge (MERGE_HEAD present) before merging ${branch}; finish or abort it manually`;
        log(message, { json: { branch, target: targetBranch, merge_in_progress: true } });
        return { ok: false, dirty: true, message };
      }
      for (const state of ["REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        let present = false;
        try { gitMergeExec(["rev-parse", "--verify", state], cwd); present = true; } catch { /* no state ref */ }
        if (!present) continue;
        const message = `Merge refused: target worktree has an in-progress ${state} before merging ${branch}; finish or abort it manually`;
        log(message, { json: { branch, target: targetBranch, sequencer_in_progress: state } });
        return { ok: false, dirty: true, message };
      }
      for (const state of ["rebase-merge", "rebase-apply", "sequencer"]) {
        const statePath = gitMergeExec(["rev-parse", "--git-path", state], cwd);
        if (!fs.existsSync(path.resolve(cwd, statePath))) continue;
        const message = `Merge refused: target worktree has an in-progress ${state} before merging ${branch}; finish or abort it manually`;
        log(message, { json: { branch, target: targetBranch, sequencer_in_progress: state } });
        return { ok: false, dirty: true, message };
      }

      // Pre-flight: unmerged index entries without MERGE_HEAD do have Posse
      // origins (a crashed conflicted squash merge, a failed stash pop), so
      // heal them — but only after the conflicted files are snapshotted; the
      // working tree may hold hand-resolution work the stash stack does not.
      // Never drop a stash here: stale conflict cleanup cannot know which
      // stash, if any, caused it.
      try {
        const unmerged = gitMergeExec(["diff", "--name-only", "--diff-filter=U"], cwd);
        if (unmerged.length > 0) {
          const files = unmerged.split("\n").filter(Boolean);
          let snapshotRef = null;
          try {
            snapshotRef = preserveDirtyWorktreeSnapshot(cwd, projectDir, {
              reason: "merge-preflight-unmerged",
              branchName: targetBranch,
              onMsg: (msg) => log(msg),
            });
          } catch (snapErr) {
            snapshotRef = null;
            log(`Pre-flight snapshot of unmerged paths failed: ${snapErr?.message || String(snapErr)}`);
          }
          if (!snapshotRef) {
            const message = `Merge refused: target worktree has ${files.length} unmerged path(s) and the pre-flight snapshot failed; resolve manually before merging ${branch}`;
            log(message, { json: { branch, target: targetBranch, files } });
            return { ok: false, dirty: true, message };
          }
          log(`Found ${files.length} unmerged path(s) from stale merge/stash state — snapshotted to ${snapshotRef} then resetting to HEAD, leaving stash stack untouched`, { json: { files, snapshot_ref: String(snapshotRef) } });
          for (const f of files) {
            gitMergeExec(["checkout", "HEAD", "--", f], cwd);
          }
        }
      } catch { /* git diff failed — proceed anyway */ }

      currentBranch = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const sweptInferTsconfig = sweepOrphanedInferTsconfig(cwd);
      if (sweptInferTsconfig) {
        log(`Removed orphaned SCIP infer-tsconfig placeholder before merging ${branch}`, {
          json: {
            branch,
            target: targetBranch,
            path: "tsconfig.json",
            original_branch: currentBranch,
          },
        });
      }
      const status = gitMergeExec(["status", "--porcelain", "--untracked-files=all"], cwd);
      const dirtyFiles = status
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !isRuntimePorcelainLine(line, cwd));
      if (dirtyFiles.length > 0) {
        const message = `Merge refused: target worktree has ${dirtyFiles.length} uncommitted change(s) before merging ${branch}`;
        log(message, {
          json: {
            branch,
            target: targetBranch,
            dirty: true,
            dirty_count: dirtyFiles.length,
            dirty_files: dirtyFiles.slice(0, 50),
            original_branch: currentBranch,
          },
        });
        return {
          ok: false,
          dirty: true,
          message,
          dirtyFiles: dirtyFiles.slice(0, 50),
        };
      }

      // Checkout target branch if not already on it
      if (currentBranch !== targetBranch) {
        log(`Checking out ${targetBranch} (was on ${currentBranch})`, { json: { from: currentBranch, to: targetBranch } });
        try {
          gitMergeExec(["checkout", targetBranch], cwd);
        } catch (checkoutErr) {
          const checkoutText = String(checkoutErr?.stderr || checkoutErr?.stdout || checkoutErr?.message || "");
          const overwriteMatch = checkoutText.match(/would be overwritten/i);
          if (overwriteMatch) {
            const checkoutBlockers = parseCheckoutOverwritePaths(checkoutErr);
            if (checkoutBlockers.length === 0) {
              const message = `Merge refused: checkout to ${targetBranch} was blocked, but no safe untracked path list could be parsed`;
              log(message, { json: { branch, target: targetBranch, error: firstGitLine(checkoutErr) } });
              return { ok: false, dirty: true, message };
            }

            let snapshotRef = null;
            try {
              snapshotRef = preserveDirtyWorktreeSnapshot(cwd, projectDir, {
                reason: `target-checkout-overwrite-${targetBranch}`,
                branchName: currentBranch,
                wiId,
                onMsg: (msg) => log(msg, { json: { branch, target: targetBranch } }),
              });
            } catch (snapshotErr) {
              const message = `Merge refused: could not snapshot checkout-blocking untracked files before switching to ${targetBranch}`;
              log(message, {
                json: {
                  branch,
                  target: targetBranch,
                  checkout_blockers: checkoutBlockers.slice(0, 50),
                  error: firstGitLine(snapshotErr),
                },
              });
              return { ok: false, dirty: true, message, dirtyFiles: checkoutBlockers.slice(0, 50) };
            }
            if (!snapshotRef) {
              const message = `Merge refused: checkout-blocking untracked files were not snapshotted before switching to ${targetBranch}`;
              log(message, {
                json: {
                  branch,
                  target: targetBranch,
                  checkout_blockers: checkoutBlockers.slice(0, 50),
                },
              });
              return { ok: false, dirty: true, message, dirtyFiles: checkoutBlockers.slice(0, 50) };
            }

            log(`Checkout blocked by conflicting untracked files — snapshotted and cleaning named paths`, {
              json: {
                branch,
                target: targetBranch,
                checkout_blockers: checkoutBlockers.slice(0, 50),
                snapshot_ref: snapshotLabel(snapshotRef),
                error: firstGitLine(checkoutErr),
              },
            });
            gitMergeExec(["clean", "-fd", "--", ...checkoutBlockers], cwd);
            gitMergeExec(["checkout", targetBranch], cwd);
          } else {
            throw checkoutErr;
          }
        }
      }

      // Merge the WI branch as a squash to avoid retry/fix-of-fix commit noise on main.
      const preMergeHead = (() => {
        try { return gitMergeExec(["rev-parse", "HEAD"], cwd); } catch { return null; }
      })();
      log(`Squash-merging ${branch} into ${targetBranch}`, { json: { branch, target: targetBranch } });
      let mergeHash = null;
      let mergeStep = "merge";
      let mergeCreated = false;
      let acceptedSourceHead = null;
      // Evidence the gate leaves for after the commit: checks merged under an
      // operator waiver or proceeding as target_unavailable (recorded on this
      // work item at the merge commit), and checks that passed (they resolve
      // earlier debt entries for the same command).
      let gateOutcome = null;

      // The first commit in (merge base, target head] where this check last
      // passed: debt attribution starts there, so neighbours merged before
      // that pass are not suspects. Falls back to the merge base.
      const attributionRangeStart = (result, candidate, mergeBase) => {
        if (!/^[0-9a-f]{40}$/i.test(String(mergeBase || ""))) return mergeBase || null;
        let commits = [];
        try {
          commits = passingReceiptCommits(String(result.test?.name || ""), { cwdRelative: result.cwd_relative || null });
        } catch { commits = []; }
        for (const commit of commits) {
          try {
            gitMergeExec(["merge-base", "--is-ancestor", commit, candidate.targetHead], candidate.checkout);
            gitMergeExec(["merge-base", "--is-ancestor", mergeBase, commit], candidate.checkout);
            return commit;
          } catch { /* not in range; try an older pass */ }
        }
        return mergeBase;
      };

      const runProjectedCandidateGate = (stagedFiles) => {
        mergeStep = "integration_gate";
        const gateDeadlineMs = Math.min(Date.now() + MERGE_GATE_WALL_BUDGET_MS, budgetEndMs);
        // Select checks before paying for a candidate checkout: registered
        // tests the changed files select, else the jobs' declared commands.
        const registered = mergeCandidateRegisteredTests({ cwd, workItemId: wiId, scopeFiles: stagedFiles });
        const declaredCommands = wiId == null || registered.tests.length > 0
          ? [] : declaredMergeCandidateCommands(listJobsByWorkItem(wiId));
        let candidateTests = registered.tests.length === 0 && declaredCommands.length === 0
          ? { ok: true, matched: 0, passed: 0, failed: 0, results: [],
            summary: registered.scopeFiles.length === 0 ? "merge candidate has no changed files"
              : "no active registered tests match the merge candidate" }
          : withTemporaryMergeCandidateCheckout({ cwd, git: gitMergeExec }, (candidate) => {
            let tests = registered.tests.length > 0
              ? runRegisteredTestsForMergeCandidate({
                cwd: candidate.checkout,
                workItemId: wiId,
                scopeFiles: stagedFiles,
                selection: registered,
                beforeEachTest: candidate.reset,
                deadlineMs: gateDeadlineMs,
                actor: {
                  role: "assessor_handoff",
                  workItemId: wiId,
                },
              })
              : runDeclaredMergeCandidateChecks({ cwd, jobs: listJobsByWorkItem(wiId), git: gitMergeExec, candidate,
                deadlineMs: gateDeadlineMs });
            if (!tests.ok && wiId != null) {
              const workItem = getWorkItem(wiId);
              const runCurrent = (initial, timeoutMs) => {
                if (tests.source === "job_test_command") {
                  const one = runDeclaredMergeCandidateChecks({
                    cwd, git: gitMergeExec,
                    jobs: [{ status: "succeeded", job_type: "dev", payload_json: JSON.stringify({ test_command: initial.test.name }) }],
                    candidate: { ...candidate, reset: () => {} },
                    run: (command, options) => runCloseoutTestCommandSync(command, { ...options, timeoutMs }),
                  });
                  return one?.results[0] || null;
                }
                const result = runRegisteredTest({
                  args: { test_id: initial.test.id, timeout_ms: timeoutMs },
                  cwd: candidate.checkout,
                  scopeFiles: stagedFiles,
                  actor: { role: "assessor_handoff", workItemId: wiId },
                });
                const failureKind = registryMergeCheckFailureKind(result);
                return { ...result, status: result.ok ? "passed" : "failed",
                  ...(failureKind ? { failure_kind: failureKind } : {}),
                  stdout: result.failure?.message || "", stderr: "",
                  exit_code: Number.isInteger(result.failure?.exit_code) ? result.failure.exit_code : result.ok ? 0 : 1,
                  signal: result.failure?.signal || null };
              };
              const lookupWorkItem = (branchName) => getDb().prepare(
                "SELECT id, branch_name, merge_state FROM work_items WHERE branch_name = ? ORDER BY id DESC LIMIT 1",
              ).get(branchName);
              tests = {
                ...tests,
                results: tests.results.map((result) => {
                  if (result.ok) return result;
                  const debt = result.status === "unavailable"
                    ? classifyUnavailableMergeCheck({
                      candidateResult: result,
                      candidateCommit: candidate.candidateCommit,
                      targetHead: candidate.targetHead,
                      reset: candidate.reset,
                      runCurrent: (timeoutMs) => runCurrent(result, timeoutMs),
                      deadlineMs: gateDeadlineMs,
                    })
                    : classifyMergeTargetDebt({
                      candidateResult: result,
                      candidateCommit: candidate.candidateCommit,
                      targetHead: candidate.targetHead,
                      rangeStart: tests.source === "job_test_command"
                        ? attributionRangeStart(result, candidate, workItem?.merge_base_hash)
                        : workItem?.merge_base_hash,
                      targetBranch,
                      checkout: candidate.checkout,
                      git: gitMergeExec,
                      reset: candidate.reset,
                      runCurrent: (timeoutMs) => runCurrent(result, timeoutMs),
                      lookupWorkItem,
                      deadlineMs: gateDeadlineMs,
                    });
                  return { ...result, target_debt_classification: debt };
                }),
              };
              const allowProvenDebt = getSetting(SETTING_KEYS.MERGE_TARGET_DEBT_AUTO_PROCEED) !== "false";
              tests.ok = allowProvenDebt && tests.results.every((result) => result.ok
                || MERGE_TARGET_PROCEEDING_OUTCOMES.includes(result.target_debt_classification?.outcome));
              const outcomes = tests.results.filter((result) => !result.ok)
                .map((result) => result.target_debt_classification?.outcome || MERGE_TARGET_COMPARISON_OUTCOMES.UNVERIFIED);
              tests.summary = `${tests.summary}; target comparison: ${outcomes.join(", ")}`;
            }
            return tests;
          });
        // Registered tests are one source of evidence; the jobs' own focused
        // receipts on the branch head are another. Report both, so an empty
        // registry never reads as "nothing was tested".
        const branchHead = mergeHeads(branch, targetBranch, cwd).branchHead;
        // Defensive: the pre-refresh check and the rebind already settled
        // this; a branch moved underneath the merge still fails closed.
        const reviewState = wiId == null ? null : currentMergeVerificationApproval(wiId);
        if (reviewState && reviewState.reviewed_branch_head !== branchHead) {
          const error = new Error(`Merge review gate #${reviewState.gate_job_id} covered a different branch commit; review the current branch before merging`);
          error.code = "POSSE_MERGE_REVIEW_STALE";
          error.gateJobId = reviewState.gate_job_id;
          throw error;
        }
        let focusedChecks = [];
        try { focusedChecks = postChangeReceiptsAtCommit(wiId, branchHead); } catch { focusedChecks = []; }
        candidateTests = { ...candidateTests, candidate_tree: gitMergeExec(["write-tree"], cwd), target_head: preMergeHead };
        for (const result of candidateTests.results) {
          const debt = result.target_debt_classification;
          if (!MERGE_TARGET_DEBT_OUTCOMES.includes(debt?.outcome)) continue;
          const introducerId = debt.introducer?.work_item_id;
          if (!introducerId) continue;
          const command = String(result.test?.name || result.test?.id || "");
          const record = recordTargetDebt(introducerId, { command, cwd_relative: result.cwd_relative || null,
            failure_fingerprint: debt.failure_fingerprint || null,
            commit: debt.introducer.commit, target_branch: targetBranch, outcome: debt.outcome,
            blocked_work_item_ids: [wiId] });
          if (!record) continue;
          logEvent({ work_item_id: wiId, event_type: EVENT_TYPES.GIT_MERGE_TARGET_DEBT,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `${targetBranch} ${debt.outcome} in ${command} introduced by WI#${introducerId}`,
            event_json: JSON.stringify({ outcome: debt.outcome, command, ...debt }) });
          logEvent({ work_item_id: introducerId, event_type: EVENT_TYPES.WORK_ITEM_TARGET_DEBT_INTRODUCED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `${command} blocked WI#${wiId} on ${targetBranch}`,
            event_json: JSON.stringify(record) });
        }
        const debtWaiver = wiId == null ? null : mergeVerificationDebtWaiver(wiId, branchHead);
        const reviewDebtWaived = mergeVerificationDebtWaiverCovers(debtWaiver, candidateTests);
        const waived = mergeTestWaiverCovers(testWaiver, candidateTests) || reviewDebtWaived;
        const focusedSummary = focusedChecks.length === 0
          ? "no focused check ran on the branch head"
          : `focused checks on the branch head: ${focusedChecks.slice(0, 4).map((check) => `${check.command || "check"} ${check.status}`).join("; ")}`;
        logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.GIT_MERGE_CANDIDATE_TESTS,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Projected merge candidate tests: ${candidateTests.summary}; ${focusedSummary}`,
          event_json: JSON.stringify({
            branch,
            target_branch: targetBranch,
            branch_head: branchHead,
            target_head: preMergeHead,
            staged_files: stagedFiles.slice(0, 100),
            focused_checks: focusedChecks.slice(0, 10),
            candidate_tree: candidateTests.candidate_tree,
            operator_waiver: waived ? testWaiver : null,
            review_debt_waiver: reviewDebtWaived ? debtWaiver : null,
            matched: candidateTests.matched,
            passed: candidateTests.passed,
            failed: candidateTests.failed,
            tests: candidateTests.results.slice(0, MERGE_GATE_STORED_RESULTS).map((result) => ({
              test_id: result.test?.id || null,
              name: result.test?.name || null,
              ok: result.ok === true,
              status: result.status || null,
              note: result.note == null ? null : mergeGateOutputTail(result.note),
              run_id: result.run_id || null,
              failure: result.failure?.message == null ? null : mergeGateOutputTail(result.failure.message),
              target_debt_classification: result.target_debt_classification || null,
            })),
          }),
        });
        if (!candidateTests.ok && !waived) {
          const firstFailure = candidateTests.results.find((result) => !result.ok);
          const debt = firstFailure?.target_debt_classification;
          const gateError = new Error(
            `Projected merge candidate ${firstFailure?.status === "unavailable" ? "has an unverified required check" : "failed test"} ${firstFailure?.test?.name || firstFailure?.test?.id || "unknown"} on ${targetBranch}`
            + `${debt ? ` (${debt.outcome}${debt.introducer ? `, WI#${debt.introducer.work_item_id}` : ""})` : ""}: `
            + `${mergeGateOutputTail(firstFailure?.failure?.message || candidateTests.summary)}`,
          );
          gateError.code = "POSSE_MERGE_CANDIDATE_TEST_FAILED";
          // Classification is done: store only bounded evidence.
          gateError.integrationGate = boundMergeGateEvidence(candidateTests);
          throw gateError;
        }
        const failing = candidateTests.results.filter((result) => !result.ok);
        gateOutcome = {
          // Failures merged under an operator or review waiver that are not
          // proven debt of another work item: this merge introduces them.
          waived: waived
            ? failing.filter((result) => !MERGE_TARGET_DEBT_OUTCOMES.includes(result.target_debt_classification?.outcome))
            : [],
          waivedByGate: waived ? (mergeTestWaiverCovers(testWaiver, candidateTests) ? testWaiver?.gate_job_id : debtWaiver?.gate_job_id) ?? null : null,
          // Unavailable on the target too: merged, but nothing verified it.
          unavailable: waived ? [] : failing.filter((result) => result.target_debt_classification?.outcome
            === MERGE_TARGET_COMPARISON_OUTCOMES.TARGET_UNAVAILABLE),
          passed: candidateTests.results.filter((result) => result.ok === true),
        };
        return candidateTests;
      };

      // Execute the squash + (optional) commit sequence and return the new
      // HEAD. Extracted so the untracked-overwrite recovery path can re-run
      // the same body after snapshotting and cleaning blockers.
      const attemptSquashMerge = (label = "merge") => {
        acceptedSourceHead = gitMergeExec(["rev-parse", branch], cwd);
        mergeStep = "runtime-path-preflight";
        const branchPaths = String(gitMergeExec([
          "-c", "core.quotePath=false", "ls-tree", "-rz", "--name-only", acceptedSourceHead,
        ], cwd, { trim: false }) || "").split("\0").filter(Boolean);
        const branchRuntimePaths = filterPosseRuntimePaths(branchPaths);
        if (branchRuntimePaths.length > 0) throw reservedRuntimeMergeError(branchRuntimePaths);

        mergeStep = "merge";
        emitMergePhase(onPhase, "merge", `${label === "merge" ? "Merging" : "Retrying merge of"} ${branch} into ${targetBranch}`, { branch, target: targetBranch });
        writeMergeInProgressMarker(gitMergeExec, cwd, {
          branch,
          target: targetBranch,
          pre_merge_head: preMergeHead,
          wi_id: wiId,
          subject: expectedSquashSubject(branch, targetBranch),
        });
        mergeMarkerWritten = true;
        gitMergeExec(["merge", "--squash", acceptedSourceHead], cwd);
        mergeStep = "diff";
        const staged = gitMergeExec(["diff", "--cached", "--name-only"], cwd);
        const stagedFiles = staged.split("\n").map((line) => line.trim()).filter(Boolean);
        const candidateRuntimePaths = candidateIndexRuntimePaths(cwd);
        if (candidateRuntimePaths.length > 0) throw reservedRuntimeMergeError(candidateRuntimePaths);
        if (stagedFiles.length > 0) {
          runProjectedCandidateGate(stagedFiles);
          log(`Creating squash merge commit for ${branch} into ${targetBranch}`, {
            json: {
              branch,
              target: targetBranch,
              staged_count: stagedFiles.length,
              staged_files: stagedFiles.slice(0, 50),
            },
          });
          emitMergePhase(onPhase, "commit", `Committing squash merge of ${branch}`, { branch, target: targetBranch });
          mergeStep = "commit";
          gitMergeExec(squashCommitArgs(expectedSquashSubject(branch, targetBranch), sharedTrunkOperationId, wiId, { branch, targetBranch, cwd, sourceHead: acceptedSourceHead }), cwd);
          mergeCreated = true;
          mergeStep = "postcommit";
        } else {
          log(`No staged changes after squash merge of ${branch}; branch likely already integrated`, {
            json: { branch, target: targetBranch },
          });
          cleanupSquashMessage(cwd);
        }
        return gitMergeExec(["rev-parse", "HEAD"], cwd);
      };

      try {
        mergeHash = attemptSquashMerge();
      } catch (mergeErr) {
        let finalMergeErr = mergeErr;
        let resolverTransientFailure = false;
        // `git merge --squash` can fail BEFORE touching the index when an
        // untracked file would be overwritten. The pre-checkout snapshot
        // path doesn't catch this because no checkout occurred (we were
        // already on targetBranch). Mirror that recovery here: snapshot
        // the blockers, clean the named paths only, and retry once.
        const mergeErrText = String(mergeErr?.stderr || mergeErr?.stdout || mergeErr?.message || "");
        const untrackedBlocked = mergeStep === "merge"
          && /untracked working tree files would be overwritten by merge/i.test(mergeErrText);
        if (untrackedBlocked) {
          const blockers = parseOverwritePaths(mergeErr);
          if (blockers.length > 0) {
            let snapshotRef = null;
            try {
              snapshotRef = preserveDirtyWorktreeSnapshot(cwd, projectDir, {
                reason: `target-checkout-overwrite-${targetBranch}`,
                branchName: currentBranch,
                wiId,
                onMsg: (msg) => log(msg, { json: { branch, target: targetBranch } }),
              });
            } catch (snapshotErr) {
              log(`Merge refused: could not snapshot merge-blocking untracked files before merging ${branch}`, {
                json: {
                  branch,
                  target: targetBranch,
                  merge_blockers: blockers.slice(0, 50),
                  error: firstGitLine(snapshotErr),
                },
              });
            }
            if (snapshotRef) {
              log(`Merge blocked by conflicting untracked files — snapshotted and cleaning named paths`, {
                json: {
                  branch,
                  target: targetBranch,
                  merge_blockers: blockers.slice(0, 50),
                  snapshot_ref: snapshotLabel(snapshotRef),
                  error: firstGitLine(mergeErr),
                },
              });
              try {
                gitMergeExec(["clean", "-fd", "--", ...blockers], cwd);
                mergeHash = attemptSquashMerge("retry");
              } catch (retryErr) {
                finalMergeErr = retryErr;
              }
            }
          }
        }

        // Cross-WI handoff duplication: a dependent branch carries a
        // pipeline-authored copy of a source WI's edits; after the source
        // squash-merges, the dependent's squash merge conflicts even though
        // the branch side is a pure addition. That shape is precisely
        // recognizable and safe to resolve by union — try it before
        // aborting. Any gate failure falls through to the normal abort,
        // which cleans the partially conflicted index.
        if (mergeHash == null && mergeStep === "merge" && !isGitTimeoutError(finalMergeErr)) {
          // Only a throw from the resolver itself is environmental; failures
          // in the post-resolution gate/commit/rev-parse below are
          // content-determined and must not suppress the deterministic-conflict
          // memo.
          let resolution = null;
          try {
            resolution = resolveHandoffSquashConflicts({ exec: gitMergeExec, cwd, branch });
            resolverTransientFailure = resolution.transient === true;
          } catch (resolveErr) {
            resolverTransientFailure = true;
            log(`Handoff conflict auto-resolution failed: ${firstGitLine(resolveErr)}`, {
              json: { branch, target: targetBranch, error: firstGitLine(resolveErr) },
            });
          }
          try {
            if (resolution?.resolved) {
              log(`Auto-resolved ${resolution.files.length} handoff-duplication conflict(s) for ${branch}`, {
                json: {
                  branch,
                  target: targetBranch,
                  auto_resolved_handoff_files: resolution.files.slice(0, 50),
                },
              });
              const staged = gitMergeExec(["diff", "--cached", "--name-only"], cwd);
              const stagedFiles = staged.split("\n").map((line) => line.trim()).filter(Boolean);
              const candidateRuntimePaths = candidateIndexRuntimePaths(cwd);
              if (candidateRuntimePaths.length > 0) throw reservedRuntimeMergeError(candidateRuntimePaths);
              if (stagedFiles.length > 0) runProjectedCandidateGate(stagedFiles);
              emitMergePhase(onPhase, "commit", `Committing squash merge of ${branch}`, { branch, target: targetBranch });
              mergeStep = "commit";
              gitMergeExec(squashCommitArgs(expectedSquashSubject(branch, targetBranch), sharedTrunkOperationId, wiId, { branch, targetBranch, cwd, sourceHead: acceptedSourceHead }), cwd);
              mergeCreated = true;
              mergeStep = "postcommit";
              mergeHash = gitMergeExec(["rev-parse", "HEAD"], cwd);
            } else if (resolution?.reason && resolution.reason !== "no_conflicted_files") {
              log(`Handoff conflict auto-resolution declined: ${resolution.reason}`, {
                json: { branch, target: targetBranch, reason: resolution.reason },
              });
            }
          } catch (commitErr) {
            finalMergeErr = commitErr;
            if (commitErr?.code !== "POSSE_MERGE_CANDIDATE_TEST_FAILED") {
              log(`Handoff conflict auto-resolution failed post-resolution: ${firstGitLine(commitErr)}`, {
                json: { branch, target: targetBranch, error: firstGitLine(commitErr) },
              });
            }
          }
        }

        if (mergeHash != null) {
          // Recovery succeeded — drop into the post-merge success block.
        } else {
        // For content conflicts, git's first stderr line is the informational
        // "Auto-merging <file>" — surface the CONFLICT lines instead so the
        // review UI names the actual blocker.
        const conflictError = mergeConflictSummary(finalMergeErr);
        const error = conflictError || firstGitLine(finalMergeErr);
        const timedOut = isGitTimeoutError(finalMergeErr);
        let unmergedFiles = [];
        try {
          unmergedFiles = gitMergeExec(["diff", "--name-only", "--diff-filter=U"], cwd)
            .split("\n").map((line) => line.trim()).filter(Boolean);
        } catch { /* the merge error remains authoritative */ }
        const hasUnmergedFiles = unmergedFiles.length > 0;
        const deterministicConflict = !timedOut
          && !resolverTransientFailure
          && (!!conflictError || hasUnmergedFiles);
        if (timedOut) {
          const recovered = recoverTimedOutMerge(branch, cwd, log, onPhase, {
            step: mergeStep,
            targetBranch,
            preMergeHead,
            sharedTrunkOperationId,
            wiId,
            sourceHead: acceptedSourceHead,
          });
          if (recovered?.ok) {
            recordReviewedSourceMerge({ workItemId: wiId, sourceHead: acceptedSourceHead, mergeHash: recovered.mergeHash, cwd, git: gitMergeExec });
            recordMergeGateOutcome({ wiId, mergeHash: recovered.mergeHash, targetBranch, outcome: gateOutcome });
            if (!suppressPostMergeEffects) {
              emitAtlasMainAdvancedAfterMerge({
                wiId,
                branchName: branch,
                targetBranch,
                mergeHash: recovered.mergeHash,
                cwd,
                source: "merge",
              });
            }
            return recovered;
          }
        }
        const failureMessage = timedOut
          ? `Merge timed out: ${branch} into ${targetBranch} after ${GIT_MERGE_TIMEOUT_MS}ms — aborting`
          : `Merge failed: ${branch} into ${targetBranch} — aborting`;
        log(failureMessage, {
          json: {
            branch,
            target: targetBranch,
            error,
            timed_out: timedOut,
            timeout_ms: timedOut ? GIT_MERGE_TIMEOUT_MS : null,
          },
        });
        // Abort the failed merge so the tree is clean — fall back to reset --merge
        try { gitMergeExec(["merge", "--abort"], cwd); } catch {
          try { gitMergeExec(["reset", "--merge"], cwd); } catch { /* last resort */ }
        }
        // Restore original branch if we switched
        if (currentBranch !== targetBranch) {
          try { gitMergeExec(["checkout", currentBranch], cwd); } catch { /* keep original merge error */ }
        }
        const restoreWarning = autoStash
          ? restoreAutoStash(cwd, autoStash, log, `failed merge of ${branch}`)
          : null;
        const failureHeads = mergeHeads(branch, targetBranch, cwd);
        const conflictFiles = !deterministicConflict ? []
          : unmergedFiles.length > 0 ? unmergedFiles : conflictFilesFromMergeError(error);
        if (deterministicConflict) {
          recordDeterministicMergeFailure(wiId, branch, targetBranch, failureHeads, error, conflictFiles);
        }
        const guidance = deterministicConflict ? `. ${parkGuidance(wiId, branch, targetBranch, conflictFiles)}` : "";
        return {
          ok: false,
          timedOut,
          runtimePathBlocked: finalMergeErr?.code === "GIT_RESERVED_RUNTIME_PATH",
          runtimePaths: finalMergeErr?.runtimePaths || [],
          ...(finalMergeErr?.code === "POSSE_MERGE_REVIEW_STALE"
            ? { reviewStale: true, gateJobId: finalMergeErr.gateJobId ?? null } : {}),
          integrationGateFailed: finalMergeErr?.code === "POSSE_MERGE_CANDIDATE_TEST_FAILED",
          integrationGate: finalMergeErr?.integrationGate || null,
          deterministicConflict,
          conflictFiles,
          branchHead: failureHeads.branchHead,
          targetHead: failureHeads.targetHead,
          message: `${timedOut ? "Merge timed out" : "Merge failed"}: ${error}${restoreWarning ? `; ${restoreWarning}` : ""}${guidance}`,
          stashPopWarning: restoreWarning,
        };
        }
      }

      // Defensive fallback for older callers/tests that may still set autoStash:
      // a restore conflict after the merge commit is a failed merge workflow, not
      // a silently recoverable success.
      let stashPopWarning = null;
      if (autoStash) {
        stashPopWarning = restoreAutoStash(cwd, autoStash, log, `merging ${branch}`);
        if (stashPopWarning) {
          return {
            ok: false,
            message: `Merge completed but auto-stash restore failed: ${stashPopWarning}`,
            stashPopWarning,
            mergeHash,
          };
        }
      }

      log(`Merged ${branch} into ${targetBranch} at ${mergeHash}`, { json: { branch, target: targetBranch, merge_hash: mergeHash } });
      recordReviewedSourceMerge({ workItemId: wiId, sourceHead: acceptedSourceHead, mergeHash, cwd, git: gitMergeExec });
      clearDeterministicMergeFailure(wiId);
      if (mergeCreated) recordMergeGateOutcome({ wiId, mergeHash, targetBranch, outcome: gateOutcome });
      if (!suppressPostMergeEffects && (mergeCreated || (preMergeHead && mergeHash && mergeHash !== preMergeHead))) {
        emitAtlasMainAdvancedAfterMerge({
          wiId,
          branchName: branch,
          targetBranch,
          mergeHash,
          cwd,
          source: "merge",
        });
      }
      return {
        ok: true,
        message: `Merged ${branch} into ${targetBranch}`,
        stashPopWarning,
        mergeHash,
        targetBranch,
      };
    } catch (err) {
      log(`Merge setup failed: ${firstGitLine(err)}`, { json: { branch, error: firstGitLine(err) } });
      // Restore original branch if we ended up on targetBranch unexpectedly
      try {
        const nowOn = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (currentBranch && nowOn === targetBranch && nowOn !== currentBranch) {
          gitMergeExec(["checkout", currentBranch], cwd);
        }
      } catch { /* best effort — don't mask the original error */ }
      const restoreWarning = autoStash
        ? restoreAutoStash(cwd, autoStash, log, `setup failure for ${branch}`)
        : null;
      return { ok: false, message: `Merge failed: ${firstGitLine(err)}${restoreWarning ? `; ${restoreWarning}` : ""}`, stashPopWarning: restoreWarning, targetBranch };
    } finally {
      // Every exit that reaches here committed or aborted the squash. Keep the
      // marker only if the squash is somehow still staged, so the next merge or
      // startup repairs it instead of a dirty-tree policy committing it.
      if (mergeMarkerWritten) settleMergeInProgressMarker(cwd);
    }
  }

  function settleMergeInProgressMarker(cwd) {
    try {
      const marker = readMergeInProgressMarker(gitMergeExec, cwd);
      if (!marker) return;
      const head = gitMergeExec(["rev-parse", "HEAD"], cwd);
      const staged = gitLinesOrNull(["diff", "--cached", "--name-only"], cwd);
      if (head === marker.pre_merge_head && (staged == null || staged.length > 0)) return;
      removeMergeInProgressMarker(gitMergeExec, cwd);
    } catch { /* the next merge pre-flight repairs or clears it */ }
  }

  /**
   * Repair a target checkout a merge interrupted mid-gate left behind. Callers
   * outside a merge take the worktree lock, so a live merge's own temporary
   * checkouts are never removed underneath it.
   */
  function recoverInterruptedSquash(cwd = projectDir, { log = null, worktreeLockAlreadyHeld = true } = {}) {
    const record = log || ((message, extra = {}) => logEvent({
      event_type: EVENT_TYPES.GIT_MERGE,
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: extra.json ? JSON.stringify(extra.json) : undefined,
    }));
    const run = () => recoverInterruptedSquashIn({
      cwd,
      exec: gitMergeExec,
      preserveSnapshot: (dir, marker) => preserveDirtyWorktreeSnapshot(dir, projectDir, {
        reason: "interrupted-merge-gate",
        branchName: marker?.target || null,
        wiId: marker?.wi_id ?? null,
        onMsg: (msg) => record(msg),
      }),
      log: record,
    });
    return worktreeLockAlreadyHeld ? run() : withWorktreeLock(cwd, projectDir, run);
  }

  function recoverInterruptedSquashAsync(cwd = projectDir, { worktreeLockAlreadyHeld = false, timeoutMs = MERGE_GATE_TASK_RESERVE_MS } = {}) {
    return runGitWorkflowTaskOffMainThread("recoverInterruptedSquash", { cwd, worktreeLockAlreadyHeld }, { timeoutMs });
  }

  async function gitMergeToTargetAsync(branch, cwd, {
    wiId = null,
    onPhase = null,
    retryDeterministicConflict = false,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
    purpose = "final",
    purposeKey = null,
    mergeLockAlreadyHeld = false,
    testWaiver = null,
  } = {}) {
    const runLocal = async ({ suppressPostMergeEffects = false, worktreeLockAlreadyHeld = false, operationId = null } = {}) => {
      const limitMs = Number(timeoutMs == null ? GIT_WORKFLOW_TASK_TIMEOUT_MS : timeoutMs);
      try {
        return await runGitWorkflowTaskOffMainThread(
          "gitMergeToTarget",
          {
            branch,
            cwd,
            wiId,
            retryDeterministicConflict,
            suppressPostMergeEffects,
            worktreeLockAlreadyHeld,
            sharedTrunkOperationId: operationId,
            testWaiver,
            taskDeadlineMs: Number.isFinite(limitMs) && limitMs > 0 ? Date.now() + limitMs : null,
          },
          { onPhase, signal, timeoutMs },
        );
      } catch (error) {
        // The terminated worker ran no finally blocks: unstage its squash and
        // remove its temporary checkouts before reporting the timeout.
        if (["THREAD_TIMEOUT", "THREAD_ABORTED"].includes(error?.code) || isAbortError(error)) {
          try {
            await recoverInterruptedSquashAsync(cwd, { worktreeLockAlreadyHeld });
          } catch (recoveryError) {
            logEvent({
              work_item_id: wiId,
              event_type: EVENT_TYPES.GIT_MERGE,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Merge recovery after ${error.code} failed; the next merge or startup repairs the target worktree: ${firstGitLine(recoveryError)}`,
              event_json: JSON.stringify({ branch, interrupted_merge_recovery: "deferred", error: firstGitLine(recoveryError) }),
            });
          }
        }
        throw error;
      }
    };
    const result = await mergeToSharedTrunkAsync({
      projectDir,
      branch,
      workItemId: wiId,
      purpose,
      purposeKey,
      mergeLocalCandidate: runLocal,
      validateCandidate: validatePushCandidateAsync,
      mergeLockAlreadyHeld,
    });
    if (result?.ok && result.mergeHash) {
      recordReviewedSourceMerge({ workItemId: wiId, mergeHash: result.mergeHash, cwd, git: gitMergeExec });
    }
    // Every merge route ends here, so the runtime log records the outcome even
    // when the events table is later purged.
    try {
      const outcome = result?.ok ? "merged" : (result?.deferred ? "deferred" : "failed");
      log[result?.ok || result?.deferred ? "info" : "warn"]("git", `Merge ${outcome}: ${branch}`, {
        wiId,
        purpose,
        outcome,
        mergeHash: result?.mergeHash || null,
        sharedTrunk: !!result?.sharedTrunk,
        message: result?.ok ? null : String(result?.message || "").slice(0, 300),
      });
    } catch { /* logging is observational */ }
    return result;
  }

  async function mergeIterativePassToTarget(wi, {
    passNumber = null,
    reason = "iterative pass",
    display = null,
    onPhase = null,
  } = {}) {
    const branchName = String(wi?.branch_name || "").trim();
    if (!branchName) return { ok: true, skipped: true, reason: "no_branch" };

    const targetBranch = currentTargetBranch();
    let sourceBranchTip = null;
    try {
      sourceBranchTip = gitExec(["rev-parse", branchName], projectDir, { timeoutMs: 5000 }).trim();
    } catch {
      sourceBranchTip = null;
    }

    const say = (message) => {
      if (display) display.addEvent(message);
      else console.log(message);
    };

    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(`Merging iterative pass for WI#${wi.id}`);
    }
    const passLabel = passNumber ?? "?";
    say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: merging pass ${passLabel} into ${targetBranch} before next loop`);

    const result = await gitMergeToTargetAsync(branchName, projectDir, {
      wiId: wi.id,
      purpose: "iterative",
      purposeKey: sourceBranchTip || `${wi.id}:${passNumber ?? "unknown"}`,
      onPhase: onPhase || ((event = {}) => {
        if (event.phase === "atlas-indexing") {
          if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS indexing iterative pass for WI#${wi.id}`);
          if (!display) say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: ATLAS post-merge indexing`);
        } else if (event.phase === "retry") {
          if (typeof display?.setRunPhase === "function") display.setRunPhase(`Retrying iterative merge for WI#${wi.id}`);
          say(`  ${C.yellow}[iterate]${C.reset} WI#${wi.id}: retrying pass merge`);
        } else if (event.phase === "merge" && typeof display?.setRunPhase === "function") {
          display.setRunPhase(`Merging iterative pass for WI#${wi.id}`);
        }
      }),
    });

    if (!result.ok) return { ...result, targetBranch, sourceBranch: branchName, sourceBranchTip };

    const mergeHash = result.mergeHash || null;
    // The shared-trunk coordinator owns the sole post-publication event and
    // ATLAS main-advance fanout, including crash recovery. Preserve the legacy
    // local-only effects when the feature is disabled.
    if (!result.sharedTrunk) {
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.WORK_ITEM_ITERATION_PASS_MERGED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Merged iterative pass ${passLabel} from ${branchName} into ${targetBranch}${mergeHash ? ` at ${mergeHash}` : ""}`,
        event_json: JSON.stringify({
          branch: branchName,
          target_branch: targetBranch,
          merge_hash: mergeHash,
          source_branch_tip: sourceBranchTip,
          pass: passNumber,
          reason,
        }),
      });
      await refreshAtlasMainAfterMerge({
        wiId: wi.id,
        branchName,
        targetBranch,
        mergeHash,
        onPhase,
        source: "iterative_merge",
      });
    }

    say(`  ${C.green}[iterate]${C.reset} WI#${wi.id}: pass ${passLabel} merged into ${targetBranch}${mergeHash ? ` (${mergeHash.slice(0, 8)})` : ""}`);
    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(`Merged iterative pass for WI#${wi.id}`);
    }
    return {
      ...result,
      targetBranch,
      sourceBranch: branchName,
      sourceBranchTip,
    };
  }


  return {
    canonicalSquashMergeEvidence,
    gitDiffStat,
    gitDiffStatAsync,
    gitMergeToTarget,
    gitMergeToTargetAsync,
    mergeIterativePassToTarget,
    reconcileCanonicalSquashMergeWorkItems,
    queueAtlasMainRefreshAfterMerge,
    recoverInterruptedSquash,
    recoverInterruptedSquashAsync,
    refreshAtlasMainAfterMerge,
  };
}
