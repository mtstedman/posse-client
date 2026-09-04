// lib/domains/git/functions/workflow-merge.js
// Merge workflow helpers for WI branches and target branch advancement.

import fs from "fs";
import path from "path";
import {
  finalizeApprovedWorkItemMerge,
  getWorkItem,
  getWorkItemMergeDependencies,
  listWorkItems,
  listCrossWiMergeBlockers,
  logEvent,
  updateWorkItemMetadata,
} from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { runHook } from "./hooks.js";
import { warmAtlasMergedToMainNow } from "../../integrations/functions/atlas.js";
import {
  emitEmbeddingsResume as emitAtlasV2EmbeddingsResume,
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  emitMergedToMain as emitAtlasV2MergedToMain,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import { GIT_OPERATION_TIMEOUT_MS } from "./utils.js";
import {
  findLegacyWorktreeForWi as nativeFindLegacyWorktreeForWi,
  preserveDirtyWorktreeSnapshot as nativePreserveDirtyWorktreeSnapshot,
  snapshotAndResetDirtyWorktree,
  worktreePath as nativeWorktreePath,
  withWorktreeLock as nativeWithWorktreeLock,
} from "./worktree.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { GIT_WORKFLOW_TASK_TIMEOUT_MS } from "./workflow-context.js";
import { GIT_MERGE_TIMEOUT_MS, firstGitLine, timedOutMergeCommitLanded } from "./workflow-git-utils.js";
import {
  DETERMINISTIC_MERGE_FAILURE_KEY,
  mergeFailureHeadsUnchanged,
  mergeConflictSummary,
  resyncHandoffBranchOntoTarget,
  resolveHandoffSquashConflicts,
} from "./handoff-conflict-resolution.js";
import { runRegisteredTestsForMergeCandidate } from "../../../shared/tools/functions/toolkit/registered-tests.js";
import { mergeToSharedTrunkAsync } from "./shared-trunk.js";

export function createMergeWorkflowHelpers(context, {
  ensureCleanTargetBranch,
  isRuntimePorcelainLine,
  sourceWorktreeDirtyState,
  sweepOrphanedInferTsconfig,
  validatePushCandidate = () => ({ ok: true }),
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

  function squashCommitArgs(subject, sharedTrunkOperationId = null) {
    const args = ["commit", "-m", subject];
    if (sharedTrunkOperationId) {
      args.push("-m", `Posse-Shared-Trunk-Operation: ${sharedTrunkOperationId}`);
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

  function recordDeterministicMergeFailure(wiId, branch, targetBranch, heads, error) {
    if (wiId == null || !heads?.branchHead || !heads?.targetHead) return;
    const metadata = workItemMetadata(wiId);
    metadata[DETERMINISTIC_MERGE_FAILURE_KEY] = {
      branch,
      target_branch: targetBranch,
      branch_head: heads.branchHead,
      target_head: heads.targetHead,
      error: String(error || "").slice(0, 1000),
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

  function recoverTimedOutMerge(branch, cwd, log, onPhase = null, {
    step = "unknown",
    targetBranch = currentTargetBranch(),
    preMergeHead = null,
    sharedTrunkOperationId = null,
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
        gitMergeExec(squashCommitArgs(subject, sharedTrunkOperationId), cwd);
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
  } = {}) {
    const targetBranch = currentTargetBranch();
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
    const priorDeterministicFailure = workItemMetadata(wiId)[DETERMINISTIC_MERGE_FAILURE_KEY];
    if (mergeFailureHeadsUnchanged(priorDeterministicFailure, initialHeads)) {
      // A content conflict is a pure function of the two tree heads. A manual
      // approval used to bypass this memo and rerun the identical merge, which
      // could only reproduce the conflict and looked like lock contention.
      // Require the source or target to move before spending another attempt.
      const message = retryDeterministicConflict
        ? `Merge retry blocked: ${branch} and ${targetBranch} have not moved since the prior deterministic conflict`
        : `Merge skipped: ${branch} and ${targetBranch} have not moved since the prior deterministic conflict`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          deterministic_conflict_unchanged: true,
          retry_requested: retryDeterministicConflict,
          branch_head: initialHeads.branchHead,
          target_head: initialHeads.targetHead,
          prior_error: priorDeterministicFailure.error || null,
        },
      });
      return {
        ok: false,
        deterministicConflict: true,
        unchangedConflict: true,
        retryRequested: retryDeterministicConflict,
        branchHead: initialHeads.branchHead,
        targetHead: initialHeads.targetHead,
        message,
      };
    }

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

    const mergedHandoffDependencies = wiId == null
      ? []
      : getWorkItemMergeDependencies(wiId)
        .map((dependency) => ({ ...dependency, source: getWorkItem(dependency.source_work_item_id) }))
        .filter((dependency) => dependency.source?.merge_state === "merged");
    const resyncWorktreeDir = (() => {
      if (wiId == null || mergedHandoffDependencies.length === 0) return null;
      const canonical = canonicalWorktreePath(projectDir, wiId);
      if (fs.existsSync(canonical)) return canonical;
      const legacy = findLegacyWorktreeForWi(projectDir, wiId);
      return legacy && fs.existsSync(legacy) ? legacy : null;
    })();
    if (
      (sourceDirty == null || sourceDirty.untrackedFiles.length === 0)
      && mergedHandoffDependencies.length > 0
      // A pruned/missing worktree is a normal post-completion state, not an
      // error: skip the resync and let the plain squash merge (plus the
      // union fallback) handle the branch from the target checkout.
      && resyncWorktreeDir != null
    ) {
      const resync = resyncHandoffBranchOntoTarget({
        exec: gitMergeExec,
        cwd,
        branch,
        targetBranch,
        worktreePath: resyncWorktreeDir,
        dependencyPaths: mergedHandoffDependencies.filter((dependency) => dependency.path),
        isIgnorableStatusLine: (line) => isRuntimePorcelainLine(line, resyncWorktreeDir),
      });
      if (resync.resynced) {
        log(`Rebased ${branch} onto ${targetBranch} after upstream handoff source merge`, {
          json: {
            branch,
            target: targetBranch,
            old_base: resync.mergeBase,
            old_head: resync.branchHead,
            rebased_head: resync.rebasedHead,
            dropped_handoff_files: resync.files?.slice(0, 50) || [],
          },
        });
      } else if (resync.infrastructureFailure) {
        // A resync that cannot run safely (worktree state unverifiable,
        // branch checked out elsewhere, residual dirt) is not a merge
        // blocker: the plain squash merge below runs from the target
        // checkout and never touches the WI worktree, and the union
        // fallback covers handoff-duplication conflicts. Deferring here
        // recreated the merge_failed loop for branches that merge cleanly.
        log(`Handoff resync skipped for ${branch} (${resync.reason}); continuing with the plain squash merge`, {
          json: {
            branch,
            target: targetBranch,
            handoff_resync_skipped: true,
            reason: resync.reason,
          },
        });
      } else if (resync.attempted && resync.conflict) {
        const message = `Merge deferred for manual review: handoff resync of ${branch} onto ${targetBranch} conflicted — ${resync.error}`;
        log(message, {
          json: {
            branch,
            target: targetBranch,
            handoff_resync_conflict: true,
            old_base: resync.mergeBase,
            branch_head: resync.branchHead,
            target_head: resync.targetHead,
            error: resync.error,
          },
        });
        recordDeterministicMergeFailure(wiId, branch, targetBranch, {
          branchHead: resync.branchHead,
          targetHead: resync.targetHead,
        }, resync.error);
        return {
          ok: false,
          deterministicConflict: true,
          rebaseConflict: true,
          branchHead: resync.branchHead,
          targetHead: resync.targetHead,
          message,
        };
      }
    }

    let currentBranch = null;
    let autoStash = null;

    try {
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

      const runProjectedCandidateGate = (stagedFiles) => {
        mergeStep = "integration_gate";
        const candidateTests = runRegisteredTestsForMergeCandidate({
          cwd,
          workItemId: wiId,
          scopeFiles: stagedFiles,
          actor: {
            role: "assessor_handoff",
            workItemId: wiId,
          },
        });
        logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.GIT_MERGE_CANDIDATE_TESTS,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Projected merge candidate tests: ${candidateTests.summary}`,
          event_json: JSON.stringify({
            branch,
            target_branch: targetBranch,
            branch_head: mergeHeads(branch, targetBranch, cwd).branchHead,
            target_head: preMergeHead,
            staged_files: stagedFiles.slice(0, 100),
            matched: candidateTests.matched,
            passed: candidateTests.passed,
            failed: candidateTests.failed,
            tests: candidateTests.results.map((result) => ({
              test_id: result.test?.id || null,
              name: result.test?.name || null,
              ok: result.ok === true,
              run_id: result.run_id || null,
              failure: result.failure?.message || null,
            })),
          }),
        });
        if (!candidateTests.ok) {
          const firstFailure = candidateTests.results.find((result) => !result.ok);
          const gateError = new Error(
            `Projected merge candidate failed registered test ${firstFailure?.test?.name || firstFailure?.test?.id || "unknown"}: ${firstFailure?.failure?.message || candidateTests.summary}`,
          );
          gateError.code = "POSSE_MERGE_CANDIDATE_TEST_FAILED";
          gateError.integrationGate = candidateTests;
          throw gateError;
        }
        return candidateTests;
      };

      // Execute the squash + (optional) commit sequence and return the new
      // HEAD. Extracted so the untracked-overwrite recovery path can re-run
      // the same body after snapshotting and cleaning blockers.
      const attemptSquashMerge = (label = "merge") => {
        mergeStep = "merge";
        emitMergePhase(onPhase, "merge", `${label === "merge" ? "Merging" : "Retrying merge of"} ${branch} into ${targetBranch}`, { branch, target: targetBranch });
        gitMergeExec(["merge", "--squash", branch], cwd);
        mergeStep = "diff";
        const staged = gitMergeExec(["diff", "--cached", "--name-only"], cwd);
        const stagedFiles = staged.split("\n").map((line) => line.trim()).filter(Boolean);
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
          gitMergeExec(squashCommitArgs(expectedSquashSubject(branch, targetBranch), sharedTrunkOperationId), cwd);
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
              if (stagedFiles.length > 0) runProjectedCandidateGate(stagedFiles);
              emitMergePhase(onPhase, "commit", `Committing squash merge of ${branch}`, { branch, target: targetBranch });
              mergeStep = "commit";
              gitMergeExec(squashCommitArgs(expectedSquashSubject(branch, targetBranch), sharedTrunkOperationId), cwd);
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
        let hasUnmergedFiles = false;
        try {
          hasUnmergedFiles = gitMergeExec(["diff", "--name-only", "--diff-filter=U"], cwd).trim().length > 0;
        } catch { /* the merge error remains authoritative */ }
        const deterministicConflict = !timedOut
          && !resolverTransientFailure
          && (!!conflictError || hasUnmergedFiles);
        if (timedOut) {
          const recovered = recoverTimedOutMerge(branch, cwd, log, onPhase, {
            step: mergeStep,
            targetBranch,
            preMergeHead,
            sharedTrunkOperationId,
          });
          if (recovered?.ok) {
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
        if (deterministicConflict) {
          recordDeterministicMergeFailure(wiId, branch, targetBranch, failureHeads, error);
        }
        return {
          ok: false,
          timedOut,
          integrationGateFailed: finalMergeErr?.code === "POSSE_MERGE_CANDIDATE_TEST_FAILED",
          integrationGate: finalMergeErr?.integrationGate || null,
          deterministicConflict,
          branchHead: failureHeads.branchHead,
          targetHead: failureHeads.targetHead,
          message: `${timedOut ? "Merge timed out" : "Merge failed"}: ${error}${restoreWarning ? `; ${restoreWarning}` : ""}`,
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
      clearDeterministicMergeFailure(wiId);
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
    }
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
  } = {}) {
    const runLocal = ({ suppressPostMergeEffects = false, worktreeLockAlreadyHeld = false, operationId = null } = {}) => runGitWorkflowTaskOffMainThread(
      "gitMergeToTarget",
      {
        branch,
        cwd,
        wiId,
        retryDeterministicConflict,
        suppressPostMergeEffects,
        worktreeLockAlreadyHeld,
        sharedTrunkOperationId: operationId,
      },
      { onPhase, signal, timeoutMs },
    );
    return mergeToSharedTrunkAsync({
      projectDir,
      branch,
      workItemId: wiId,
      purpose,
      purposeKey,
      mergeLocalCandidate: runLocal,
      validateCandidate: validatePushCandidate,
      mergeLockAlreadyHeld,
    });
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
    refreshAtlasMainAfterMerge,
  };
}
