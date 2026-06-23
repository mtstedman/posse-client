// lib/domains/git/functions/workflow-review-worktrees.js
// Read-only dirty-state audits and human-facing worktree review output.

import fs from "fs";
import { execFileSync, execSync } from "child_process";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { listWorkItems } from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { worktreePath as canonicalWorktreePath, findLegacyWorktreeForWi } from "./worktree.js";

export function createReviewWorktreeHelpers(context, { isRuntimePorcelainLine }) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread } = context;

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
          const status = execSync("git status --porcelain", { cwd: wtDir, encoding: "utf-8", timeout: 5000 }).trim();
          if (status) {
            const fileCount = status.split("\n").length;
            issues.push({ type: "dirty", message: `${fileCount} uncommitted change(s) in worktree`, files: status });
          }
        } catch { /* worktree may be broken */ }

        // Check for stashes
        try {
          const stashList = execSync("git stash list", { cwd: wtDir, encoding: "utf-8", timeout: 5000 }).trim();
          if (stashList) {
            const stashCount = stashList.split("\n").length;
            issues.push({ type: "stash", message: `${stashCount} stash(es) with uncommitted work` });
          }
        } catch { /* ignore */ }
      }

      // Check if branch has commits not yet merged into target
      if (wi.merge_state !== "merged") {
        try {
          const ahead = execFileSync("git", ["rev-list", `${targetBranch}..${wi.branch_name}`, "--count"], {
            cwd: projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
          }).trim();
          if (parseInt(ahead) > 0) {
            issues.push({ type: "unmerged", message: `${ahead} commit(s) not merged into ${targetBranch}` });
          }
        } catch {
          // Branch referenced in DB but doesn't exist in git — orphaned record
          try {
            execFileSync("git", ["rev-parse", "--verify", wi.branch_name], { cwd: projectDir, encoding: "utf-8", stdio: "pipe", timeout: 3000 });
          } catch {
            issues.push({ type: "orphan_ref", message: `Branch ${wi.branch_name} no longer exists in git (DB record is stale)` });
          }
        }
      }

      // Worktree dir exists but WI is terminal (should have been cleaned up)
      if (wtExists && TERMINAL_WORK_ITEM_STATUSES.includes(wi.status)) {
        issues.push({ type: "orphan", message: `Worktree still exists but WI is ${wi.status}` });
      }

      if (issues.length > 0) {
        results.push({ wiId: wi.id, title: wi.title, branchName: wi.branch_name, wtDir, wtExists, issues });
      }
    }

    return results;
  }

  function collectDirtyState() {
    const targetBranch = currentTargetBranch();
    const dirtyItems = auditWorktreeState();
    let targetStatus = "";
    try {
      targetStatus = execSync("git status --porcelain", { cwd: projectDir, encoding: "utf-8", timeout: 5000 }).trim();
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
      status = execSync("git status --porcelain --untracked-files=all", {
        cwd: wtDir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return null;
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
    const unmerged = dirtyItems.filter(d => d.issues.some(i => i.type === "unmerged"));
    const dirty = dirtyItems.filter(d => d.issues.some(i => i.type === "dirty"));
    const orphans = dirtyItems.filter(d => d.issues.some(i => i.type === "orphan"));

    if (unmerged.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${unmerged.length} work item branch(es) with unmerged commits:${C.reset}`);
      for (const item of unmerged) {
        const issue = item.issues.find(i => i.type === "unmerged");
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.branchName})${C.reset}`);
        console.log(`      ${issue.message}`);
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

    if (orphans.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${orphans.length} orphaned worktree(s) (WI is terminal):${C.reset}`);
      for (const item of orphans) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
      }
    }

    // Offer cleanup walkthrough if there are actionable issues
    if (dirty.length > 0 || orphans.length > 0 || unmerged.length > 0 || targetDirty) {
      console.log(`\n  ${C.bold}Cleanup walkthrough:${C.reset}`);

      if (unmerged.length > 0) {
        console.log(`\n  ${C.cyan}Unmerged branches${C.reset} \u2014 these have commits that didn't make it into ${targetBranch}:`);
        console.log(`    To review and merge:  ${C.bold}node orchestrator.js merge <WI-ID>${C.reset}`);
        console.log(`    To inspect the diff:  ${C.bold}git diff ${targetBranch}...<branch-name>${C.reset}`);
        console.log(`    To discard:           ${C.bold}node orchestrator.js purge${C.reset} (interactive, asks per branch)`);
      }

      if (dirty.length > 0) {
        console.log(`\n  ${C.cyan}Dirty worktrees${C.reset} \u2014 uncommitted changes in work branches:`);
        console.log(`    To inspect:  ${C.bold}cd <worktree-path> && git status && git diff${C.reset}`);
        console.log(`    To commit:   ${C.bold}cd <worktree-path> && git add -A && git commit -m "WIP"${C.reset}`);
        console.log(`    To discard:  ${C.bold}cd <worktree-path> && git checkout -- . && git clean -fd${C.reset}`);
      }

      if (orphans.length > 0) {
        console.log(`\n  ${C.cyan}Orphaned worktrees${C.reset} \u2014 WI is done but worktree/branch wasn't cleaned up:`);
        console.log(`    To clean all: ${C.bold}node orchestrator.js purge${C.reset}`);
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
