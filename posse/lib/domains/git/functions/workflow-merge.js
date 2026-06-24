// lib/domains/git/functions/workflow-merge.js
// Merge workflow helpers for WI branches and target branch advancement.

import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { listCrossWiMergeBlockers, logEvent } from "../../queue/functions/index.js";
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
  preserveDirtyWorktreeSnapshot,
  snapshotAndResetDirtyWorktree,
  withWorktreeLock,
} from "./worktree.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { GIT_WORKFLOW_TASK_TIMEOUT_MS } from "./workflow-context.js";
import { GIT_MERGE_TIMEOUT_MS, firstGitLine } from "./workflow-git-utils.js";

export function createMergeWorkflowHelpers(context, {
  ensureCleanTargetBranch,
  isRuntimePorcelainLine,
  sourceWorktreeDirtyState,
  sweepOrphanedInferTsconfig,
}) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread } = context;

  function gitDiffStat(mergeBase, branch, cwd) {
    try {
      const raw = execFileSync("git", ["diff", "--stat", `${mergeBase}...${branch}`], { cwd, encoding: "utf-8", timeout: GIT_OPERATION_TIMEOUT_MS });
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
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_MERGE_TIMEOUT_MS,
    });
    return trim ? String(out || "").trim() : String(out || "");
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
    if (isAtlasV2EmissionEnabled() && (replay.ok === false || replay.skipped === "source_branch_missing")) {
      emitAtlasV2MergedToMain({
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
          message: `ATLAS merge outbox fallback failed for ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
          event_json: JSON.stringify({
            branch: branchName || null,
            target_branch: targetBranch || null,
            merge_hash: mergeHash || null,
            error: err?.message || String(err),
          }),
        }),
      });
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

  function gitLines(args, cwd) {
    try {
      return gitMergeExec(args, cwd)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
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

  function recoverTimedOutMerge(branch, cwd, log, onPhase = null, { step = "unknown", targetBranch = currentTargetBranch() } = {}) {
    const canRecover = step === "commit" || step === "postcommit";
    if (!canRecover) return null;

    const subject = expectedSquashSubject(branch, targetBranch);
    const head = (() => {
      try { return gitMergeExec(["rev-parse", "HEAD"], cwd); } catch { return null; }
    })();
    const headSubject = (() => {
      try { return gitMergeExec(["show", "-s", "--format=%s", "HEAD"], cwd); } catch { return ""; }
    })();
    const stagedFiles = gitLines(["diff", "--cached", "--name-only"], cwd);
    const unmergedFiles = gitLinesOrNull(["diff", "--name-only", "--diff-filter=U"], cwd);
    if (unmergedFiles == null) {
      return null;
    }

    if (head && headSubject === subject && unmergedFiles.length === 0) {
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
        emitMergePhase(onPhase, "atlas-indexing", `ATLAS indexing ${branch}`, { branch, target: targetBranch, retry: true });
        gitMergeExec(["commit", "-m", subject], cwd);
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

  function gitMergeToTarget(branch, cwd, { wiId = null, onPhase = null } = {}) {
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

    const sourceDirty = sourceWorktreeDirtyState(wiId);
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

    let currentBranch = null;
    let autoStash = null;

    try {
      // Pre-flight: clean up any stale merge state (MERGE_HEAD from aborted merge)
      let hasMergeHead = false;
      try {
        gitMergeExec(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
        hasMergeHead = true;
      } catch {
        hasMergeHead = false;
      }
      if (hasMergeHead) {
        log(`Found stale MERGE_HEAD — cleaning up before merge of ${branch}`);
        try { gitMergeExec(["merge", "--abort"], cwd); } catch {
          gitMergeExec(["reset", "--merge"], cwd);
        }
      }

      // Pre-flight: clean up unmerged index entries (left by failed stash pop)
      // These have no MERGE_HEAD but leave conflict markers in the working tree.
      // Accept the current HEAD version and move on. Never drop a stash here:
      // stale conflict cleanup cannot know which stash, if any, caused it.
      try {
        const unmerged = gitMergeExec(["diff", "--name-only", "--diff-filter=U"], cwd);
        if (unmerged.length > 0) {
          const files = unmerged.split("\n").filter(Boolean);
          log(`Found ${files.length} unmerged path(s) from stale stash pop — resetting to HEAD and leaving stash stack untouched`, { json: { files } });
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
          log(`Creating squash merge commit for ${branch} into ${targetBranch}`, {
            json: {
              branch,
              target: targetBranch,
              staged_count: stagedFiles.length,
              staged_files: stagedFiles.slice(0, 50),
            },
          });
          emitMergePhase(onPhase, "atlas-indexing", `ATLAS indexing ${branch}`, { branch, target: targetBranch });
          mergeStep = "commit";
          gitMergeExec(["commit", "-m", expectedSquashSubject(branch, targetBranch)], cwd);
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

        if (mergeHash != null) {
          // Recovery succeeded — drop into the post-merge success block.
        } else {
        const error = firstGitLine(finalMergeErr);
        const timedOut = isGitTimeoutError(finalMergeErr);
        if (timedOut) {
          const recovered = recoverTimedOutMerge(branch, cwd, log, onPhase, { step: mergeStep, targetBranch });
          if (recovered?.ok) {
            emitAtlasMainAdvancedAfterMerge({
              wiId,
              branchName: branch,
              targetBranch,
              mergeHash: recovered.mergeHash,
              cwd,
              source: "merge",
            });
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
        return {
          ok: false,
          timedOut,
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
      if (mergeCreated || (preMergeHead && mergeHash && mergeHash !== preMergeHead)) {
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

  function gitMergeToTargetAsync(branch, cwd, {
    wiId = null,
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    return runGitWorkflowTaskOffMainThread("gitMergeToTarget", { branch, cwd, wiId }, { onPhase, signal, timeoutMs });
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
      sourceBranchTip = execFileSync("git", ["rev-parse", branchName], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
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
    gitDiffStat,
    gitDiffStatAsync,
    gitMergeToTarget,
    gitMergeToTargetAsync,
    mergeIterativePassToTarget,
    refreshAtlasMainAfterMerge,
  };
}
