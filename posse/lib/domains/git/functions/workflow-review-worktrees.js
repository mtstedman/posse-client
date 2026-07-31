// lib/domains/git/functions/workflow-review-worktrees.js
// Read-only dirty-state audits and human-facing worktree review output.

import fs from "fs";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { listWorkItems } from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import {
  worktreePath as nativeWorktreePath,
  findLegacyWorktreeForWi as nativeFindLegacyWorktreeForWi,
} from "./worktree.js";

export function createReviewWorktreeHelpers(context, { isRuntimePorcelainLine }) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread, gitExec } = context;
  const canonicalWorktreePath = context.worktreePath || nativeWorktreePath;
  const findLegacyWorktreeForWi = context.findLegacyWorktree || nativeFindLegacyWorktreeForWi;

  function auditWorktreeState() {
    const targetBranch = currentTargetBranch();
    const results = [];
    const allWIs = listWorkItems();

    for (const wi of allWIs) {
      if (!wi.branch_name) continue;

      const issues = [];
      const canonical = canonicalWorktreePath(projectDir, wi.id);
      const legacy = fs.existsSync(canonical) ? null : findLegacyWorktreeForWi(projectDir, wi.id);
      const wtDir = legacy || canonical;

      // Check if worktree directory exists
      const wtExists = fs.existsSync(wtDir);

      // Check for dirty worktree (uncommitted changes)
      if (wtExists) {
        try {
          const status = gitExec(["status", "--porcelain"], wtDir, { timeoutMs: 5000 }).trim();
          const userStatus = status
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !isRuntimePorcelainLine(line, wtDir));
          if (userStatus.length > 0) {
            issues.push({
              type: "dirty",
              message: `${userStatus.length} uncommitted change(s) in worktree`,
              files: userStatus.join("\n"),
            });
          }
        } catch {
          issues.push({
            type: "worktree_check_failed",
            message: "Could not verify worktree cleanliness",
          });
        }

      }

      // Check if branch has commits not yet merged into target
      if (wi.merge_state !== "merged") {
        try {
          const ahead = gitExec(["rev-list", `${targetBranch}..${wi.branch_name}`, "--count"], projectDir, { timeoutMs: 5000 }).trim();
          if (parseInt(ahead) > 0) {
            issues.push({ type: "unmerged", message: `${ahead} commit(s) not merged into ${targetBranch}` });
          }
        } catch {
          // Branch referenced in DB but doesn't exist in git — orphaned record
          try {
            gitExec(["rev-parse", "--verify", wi.branch_name], projectDir, { timeoutMs: 3000 });
          } catch {
            issues.push({ type: "orphan_ref", message: `Branch ${wi.branch_name} no longer exists in git (DB record is stale)` });
          }
        }
      }

      // A terminal worktree can mean either preserved, unmerged work or a
      // harmless cleanup retry after a successful merge. Keep those states
      // distinct so wrap-up never tells an operator that merged work is at
      // risk, or that unmerged work is safe to purge.
      if (wtExists && TERMINAL_WORK_ITEM_STATUSES.includes(wi.status)) {
        const hasUncommittedWork = issues.some((issue) => issue.type === "dirty");
        const worktreeCheckFailed = issues.some((issue) =>
          issue.type === "worktree_check_failed"
        );
        if (wi.merge_state === "merged" && worktreeCheckFailed) {
          issues.push({
            type: "cleanup_unverified",
            message: "Merge is recorded, but the remaining worktree could not be verified as clean",
          });
        } else if (wi.merge_state === "merged" && !hasUncommittedWork) {
          issues.push({
            type: "merged_residue",
            message: `Merge is recorded; only worktree/branch cleanup remains`,
          });
        } else {
          issues.push({
            type: "terminal_unmerged",
            message: `WI is ${wi.status}, but its worktree is not confirmed clean and merged`,
          });
        }
      }

      if (issues.length > 0) {
        results.push({
          wiId: wi.id,
          title: wi.title,
          status: wi.status,
          mergeState: wi.merge_state,
          branchName: wi.branch_name,
          wtDir,
          wtExists,
          issues,
        });
      }
    }

    return results;
  }

  function collectDirtyState() {
    const targetBranch = currentTargetBranch();
    const dirtyItems = auditWorktreeState();
    let targetStatus = "";
    try {
      targetStatus = gitExec(["status", "--porcelain"], projectDir, { timeoutMs: 5000 }).trim();
    } catch {
      targetStatus = "";
    }
    return {
      targetBranch,
      dirtyItems,
      targetStatus,
      targetDirty: !!targetStatus,
    };
  }

  function collectDirtyStateAsync(workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("collectDirtyState", {}, workerOptions);
  }

  function sourceWorktreeDirtyState(wiId) {
    if (wiId == null) return null;
    const canonical = canonicalWorktreePath(projectDir, wiId);
    const legacy = fs.existsSync(canonical) ? null : findLegacyWorktreeForWi(projectDir, wiId);
    const wtDir = legacy || canonical;
    if (!fs.existsSync(wtDir)) return null;
    let status = "";
    try {
      status = gitExec(["status", "--porcelain", "--untracked-files=all"], wtDir, { timeoutMs: 5000 }).trim();
    } catch (err) {
      return {
        wtDir,
        dirtyFiles: [],
        trackedFiles: [],
        untrackedFiles: [],
        verificationFailed: true,
        error: String(err?.message || err || "unknown Git error").slice(0, 500),
      };
    }
    const dirtyFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isRuntimePorcelainLine(line, wtDir));
    if (dirtyFiles.length === 0) return null;
    // Tracked changes are potential lost work and block the merge; untracked
    // leftovers are agent scaffolding that never entered a commit and can be
    // snapshotted away.
    const trackedFiles = dirtyFiles.filter((line) => !line.startsWith("??"));
    const untrackedFiles = dirtyFiles.filter((line) => line.startsWith("??"));
    return { wtDir, dirtyFiles, trackedFiles, untrackedFiles };
  }


  /**
   * Display dirty worktree warnings and offer a walkthrough to clean them up.
   * Returns true if there are blocking issues (dirty target branch).
   */
  async function notifyDirtyState() {
    const state = await collectDirtyStateAsync().catch(() => collectDirtyState());
    const targetBranch = state.targetBranch || currentTargetBranch();
    const dirtyItems = Array.isArray(state.dirtyItems) ? state.dirtyItems : [];
    const targetStatus = String(state.targetStatus || "").trim();
    const targetDirty = !!targetStatus;

    if (targetDirty) {
      console.log(`\n  ${C.red}${C.bold}\u26a0 Target branch (${targetBranch}) has uncommitted changes:${C.reset}`);
      const lines = targetStatus.split("\n").slice(0, 10);
      for (const line of lines) {
        console.log(`    ${C.dim}${line}${C.reset}`);
      }
      if (targetStatus.split("\n").length > 10) {
        console.log(`    ${C.dim}... and ${targetStatus.split("\n").length - 10} more${C.reset}`);
      }
    }

    if (dirtyItems.length === 0 && !targetDirty) return false;

    // Show WI branch issues
    const terminalUnmerged = dirtyItems.filter(d => d.issues.some(i => i.type === "terminal_unmerged"));
    const cleanupUnverified = dirtyItems.filter(d => d.issues.some(i => i.type === "cleanup_unverified"));
    const mergedResidue = dirtyItems.filter(d => d.issues.some(i => i.type === "merged_residue"));
    const unmerged = dirtyItems.filter(d =>
      d.issues.some(i => i.type === "unmerged")
      && !d.issues.some(i => i.type === "terminal_unmerged")
    );
    const dirty = dirtyItems.filter(d => d.issues.some(i => i.type === "dirty"));

    if (unmerged.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${unmerged.length} work item branch(es) with unmerged commits:${C.reset}`);
      for (const item of unmerged) {
        const issue = item.issues.find(i => i.type === "unmerged");
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.branchName})${C.reset}`);
        console.log(`      ${issue.message}`);
      }
    }

    if (terminalUnmerged.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${terminalUnmerged.length} terminal worktree(s) with work not confirmed merged:${C.reset}`);
      for (const item of terminalUnmerged) {
        const issue = item.issues.find(i => i.type === "terminal_unmerged");
        const mergeState = item.mergeState || "not merged";
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
        console.log(`      ${issue.message}; merge state: ${mergeState}`);
      }
    }

    if (dirty.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${dirty.length} worktree(s) with uncommitted changes:${C.reset}`);
      for (const item of dirty) {
        const issue = item.issues.find(i => i.type === "dirty");
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
        console.log(`      ${issue.message}`);
      }
    }

    if (cleanupUnverified.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${cleanupUnverified.length} merged worktree(s) requiring cleanup verification:${C.reset}`);
      for (const item of cleanupUnverified) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
        console.log(`      Merge is recorded, but Posse could not verify that the leftover worktree is clean.`);
      }
    }

    if (mergedResidue.length > 0) {
      console.log(`\n  ${C.cyan}${C.bold}\u2139 ${mergedResidue.length} merged worktree(s) awaiting cleanup:${C.reset}`);
      for (const item of mergedResidue) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
        console.log(`      Merge is recorded; the worktree is cleanup residue, not an unmerged change.`);
      }
    }

    // Offer cleanup walkthrough if there are actionable issues
    if (
      dirty.length > 0
      || terminalUnmerged.length > 0
      || cleanupUnverified.length > 0
      || mergedResidue.length > 0
      || unmerged.length > 0
      || targetDirty
    ) {
      console.log(`\n  ${C.bold}Cleanup walkthrough:${C.reset}`);

      if (unmerged.length > 0) {
        console.log(`\n  ${C.cyan}Unmerged branches${C.reset} \u2014 these have commits that didn't make it into ${targetBranch}:`);
        console.log(`    To review and merge:  ${C.bold}posse merge <WI-ID>${C.reset}`);
        console.log(`    To inspect the diff:  ${C.bold}git diff ${targetBranch}...<branch-name>${C.reset}`);
        console.log(`    To discard:           ${C.bold}posse purge${C.reset} (interactive, asks per branch)`);
      }

      if (terminalUnmerged.length > 0) {
        console.log(`\n  ${C.cyan}Terminal but unmerged worktrees${C.reset} \u2014 status is terminal, but work is not confirmed on ${targetBranch}:`);
        console.log(`    To inspect:  ${C.bold}cd <worktree-path> && git status && git diff${C.reset}`);
        console.log(`    To preserve: ${C.bold}cd <worktree-path> && git add -A && git commit -m "Preserve work"${C.reset}`);
        console.log(`    To merge:    ${C.bold}posse merge <WI-ID>${C.reset}`);
        console.log(`    Do not purge until the work has been inspected or merged.`);
      }

      if (dirty.length > 0) {
        console.log(`\n  ${C.cyan}Dirty worktrees${C.reset} \u2014 uncommitted changes in work branches:`);
        console.log(`    To inspect:  ${C.bold}cd <worktree-path> && git status && git diff${C.reset}`);
        console.log(`    To commit:   ${C.bold}cd <worktree-path> && git add -A && git commit -m "WIP"${C.reset}`);
        console.log(`    To discard:  ${C.bold}cd <worktree-path> && git checkout -- . && git clean -fd${C.reset}`);
      }

      if (mergedResidue.length > 0) {
        console.log(`\n  ${C.cyan}Merged cleanup residue${C.reset} \u2014 changes are already recorded on the target branch:`);
        console.log(`    To retry safe cleanup: ${C.bold}posse prune${C.reset}`);
      }

      if (cleanupUnverified.length > 0) {
        console.log(`\n  ${C.cyan}Unverified merged cleanup${C.reset} \u2014 the merge is recorded, but inspect the leftover before pruning:`);
        console.log(`    To inspect: ${C.bold}cd <worktree-path> && git status${C.reset}`);
        console.log(`    When clean: ${C.bold}posse prune${C.reset}`);
      }

      if (targetDirty) {
        console.log(`\n  ${C.cyan}Dirty target branch${C.reset} \u2014 uncommitted changes on ${targetBranch}:`);
        console.log(`    To stash:    ${C.bold}git stash push -u -m "pre-push stash"${C.reset}`);
        console.log(`    To commit:   ${C.bold}git add -A && git commit -m "WIP"${C.reset}`);
        console.log(`    To discard:  ${C.bold}git checkout -- . && git clean -fd${C.reset}`);
      }

      console.log("");
    }

    return targetDirty;
  }

  /**
   * Offer to push the target branch to remote if there are unpushed commits.
   * Used after both manual approval and auto-approval merges.
   */

  return {
    auditWorktreeState,
    collectDirtyState,
    collectDirtyStateAsync,
    sourceWorktreeDirtyState,
    notifyDirtyState,
  };
}
