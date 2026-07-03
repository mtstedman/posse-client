import fs from "fs";
import path from "path";
import { initArtifactRoots, pruneEmptyArtifactDirs } from "../../artifacts/functions/index.js";
import { buildInventory, inventoryIsEmpty, inventorySummary } from "../../cleanup/functions/survey.js";
import { triageInventory, buildItemIndex } from "../../cleanup/functions/triage.js";
import { applyAction } from "../../cleanup/functions/actions.js";
import { deleteBranchPreservingTip, snapshotAndResetDirtyWorktree } from "../../git/functions/worktree.js";
import { gitExec } from "../../git/functions/utils.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { clearAll, getLiveSchedulerBlockMessage, listWorkItems } from "../../queue/functions/index.js";
import { C as defaultColors } from "../../../shared/format/functions/colors.js";
import { ask as defaultAsk } from "./input-prompts.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { worktreeRoot } from "../../worker/classes/Worker.js";

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);

function clearWorktreeLockFiles(projectDir) {
  const lockDir = path.join(getRuntimeRoot(projectDir), "worktree-locks");
  if (!fs.existsSync(lockDir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(lockDir, { withFileTypes: true });
    count = entries.length;
  } catch {
    count = 0;
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort: a failed removal should not leave the DB half-cleared.
  }
  return count;
}

function requireFn(name, value) {
  if (typeof value !== "function") {
    throw new Error(`maintenance commands require ${name}`);
  }
  return value;
}

export function createMaintenanceCommands({
  projectDir,
  targetBranch,
  getTargetBranch = null,
  C = defaultColors,
  ask = defaultAsk,
  cleanupWiBranch,
  gitBranchExists,
  gitWorktreePathsForBranch,
  gitWorktreeRemove,
} = {}) {
  if (!projectDir) throw new Error("createMaintenanceCommands requires projectDir");

  const cleanupBranch = requireFn("cleanupWiBranch", cleanupWiBranch);
  const branchExists = requireFn("gitBranchExists", gitBranchExists);
  const branchWorktreePaths = requireFn("gitWorktreePathsForBranch", gitWorktreePathsForBranch);
  const removeWorktree = requireFn("gitWorktreeRemove", gitWorktreeRemove);

  function resolveMaintenanceTargetBranch(commandName) {
    const resolved = typeof getTargetBranch === "function" ? getTargetBranch() : targetBranch;
    const branch = String(resolved || "").trim();
    if (!branch) throw new Error(`${commandName} requires targetBranch`);
    return branch;
  }

  function refuseIfSchedulerLive(commandName) {
    const msg = getLiveSchedulerBlockMessage("main");
    if (!msg) return false;
    console.log(`\n  ${C.red}${commandName} refused:${C.reset} ${msg}\n`);
    process.exitCode = 1;
    return true;
  }

  async function clear() {
    if (refuseIfSchedulerLive("clear")) return;
    const confirm = await ask(`\n  ${C.red}This will delete all work items, jobs, and git branches/worktrees. Artifacts and logs are preserved. Continue? (yes/n): ${C.reset}`);
    if (confirm !== "yes") {
      console.log("  Cancelled.");
      return;
    }
    if (refuseIfSchedulerLive("clear")) return;

    let cleanupFailures = 0;
    try {
      const workItems = listWorkItems();
      for (const wi of workItems) {
        if (wi.branch_name) {
          try {
            if (!await Promise.resolve(cleanupBranch(wi, { clearMergeState: true }))) cleanupFailures += 1;
          } catch {
            cleanupFailures += 1;
          }
        }
      }
    } catch {
      // best effort cleanup
    }

    if (cleanupFailures > 0) {
      console.log(`\n  ${C.red}Clear aborted:${C.reset} ${cleanupFailures} branch cleanup(s) failed, so DB branch metadata was preserved.\n`);
      process.exitCode = 1;
      return;
    }

    const wtRoot = worktreeRoot(projectDir);
    if (fs.existsSync(wtRoot)) {
      try {
        gitExec(["worktree", "prune"], projectDir);
      } catch {
        // best effort
      }
      try {
        fs.rmSync(wtRoot, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }

    clearAll();
    const prunedLocks = clearWorktreeLockFiles(projectDir);
    const pruned = pruneEmptyArtifactDirs(projectDir);
    initArtifactRoots(projectDir);
    const pruneMsg = pruned > 0 ? `; ${pruned} empty dir(s) pruned` : "";
    const lockMsg = prunedLocks > 0 ? `; ${prunedLocks} stale lock file(s) removed` : "";
    console.log(`\n  ${C.green}Session cleared.${C.reset} ${C.dim}(artifact files, event log, and agent call history preserved; git branches cleaned${pruneMsg}${lockMsg})${C.reset}\n`);
  }

  async function prune(argv = process.argv) {
    if (refuseIfSchedulerLive("prune")) return;
    const wtBase = worktreeRoot(projectDir);
    const dryRun = argv.includes("--dry-run");
    const yes = argv.includes("--yes") || argv.includes("-y");

    if (!fs.existsSync(wtBase)) {
      console.log(`\n  ${C.dim}No worktree directory found.${C.reset}\n`);
      return;
    }

    const entries = fs.readdirSync(wtBase);
    if (entries.length === 0) {
      console.log(`\n  ${C.dim}Worktree directory is empty.${C.reset}\n`);
      return;
    }

    const allWIs = listWorkItems();
    let wouldPrune = 0;
    const candidates = [];
    let pruned = 0;
    let failed = 0;

    console.log(`\n  ${C.bold}Worktree Prune${C.reset}${dryRun ? ` ${C.dim}(dry-run)${C.reset}` : ""}\n`);

    for (const entry of entries) {
      const wtPath = path.join(wtBase, entry);
      const match = entry.match(/^wi-(\d+)(?:-|$)/);
      if (!match) {
        console.log(`  ${C.dim}? ${entry} - unrecognized format, skipping${C.reset}`);
        continue;
      }

      const wiId = Number.parseInt(match[1], 10);
      const wi = allWIs.find(w => w.id === wiId);

      if (!wi) {
        console.log(`  ${C.red}x ${entry}${C.reset} - WI#${wiId} not found in DB -> would remove`);
        wouldPrune += 1;
        candidates.push({ entry, wtPath, wiId, wi: null });
      } else if (TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status) && !wi.branch_name) {
        console.log(`  ${C.red}x ${entry}${C.reset} - WI#${wiId} is ${wi.status}, branch cleared -> would remove`);
        wouldPrune += 1;
        candidates.push({ entry, wtPath, wiId, wi });
      } else if (TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status)) {
        console.log(`  ${C.red}x ${entry}${C.reset} - WI#${wiId} is ${wi.status}, branch still set (${wi.branch_name}) -> would remove worktree only`);
        wouldPrune += 1;
        candidates.push({ entry, wtPath, wiId, wi });
      } else {
        console.log(`  ${C.green}+ ${entry}${C.reset} - WI#${wiId} is ${wi.status} (active)`);
      }
    }

    if (dryRun) {
      const pruneSummary = wouldPrune > 0 ? `${C.yellow}Dry-run: would prune ${wouldPrune} worktree(s).` : `${C.dim}Dry-run: nothing to prune.`;
      console.log(`\n  ${pruneSummary}${C.reset}\n`);
      return;
    }

    if (candidates.length > 0 && !yes) {
      const confirm = (await ask(`\n  Remove ${candidates.length} stale worktree(s)? (y/N): `)).trim().toLowerCase();
      if (confirm !== "y" && confirm !== "yes") {
        console.log(`  ${C.dim}Canceled. No worktrees removed.${C.reset}\n`);
        return;
      }
    }
    if (candidates.length > 0 && refuseIfSchedulerLive("prune")) return;

    for (const candidate of candidates) {
      try {
        snapshotAndResetDirtyWorktree(candidate.wtPath, projectDir, {
          reason: "manual-prune",
          branchName: candidate.wi?.branch_name || null,
          wiId: candidate.wiId,
        });
      } catch (err) {
        failed += 1;
        console.log(`    ${C.yellow}Could not snapshot ${candidate.entry}; leaving it for manual cleanup (${err.message})${C.reset}`);
        continue;
      }
      if (removeWorktree(candidate.wtPath, projectDir)) {
        pruned += 1;
      } else {
        failed += 1;
        console.log(`    ${C.yellow}Could not remove ${candidate.entry}; leaving it for manual cleanup${C.reset}`);
      }
    }

    if (candidates.length > 0) {
      try {
        gitExec(["worktree", "prune"], projectDir);
      } catch {
        // best effort
      }
    }

    const pruneSummary = pruned > 0 ? `${C.green}Pruned ${pruned} worktree(s).` : `${C.dim}Nothing to prune.`;
    const failureSummary = failed > 0 ? ` ${C.yellow}${failed} removal(s) failed.${C.reset}` : "";
    console.log(`\n  ${pruneSummary}${C.reset}${failureSummary}\n`);
  }

  async function purge() {
    if (refuseIfSchedulerLive("purge")) return;
    console.log(`\n  ${C.bold}Purge Unmerged Branches${C.reset}\n`);
    const resolvedTargetBranch = resolveMaintenanceTargetBranch("purge");

    let branches = [];
    try {
      const raw = gitExec(["branch", "--list", "posse/*"], projectDir).trim();
      if (raw) branches = raw.split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
    } catch {
      // no branches
    }

    if (branches.length === 0) {
      console.log(`  ${C.dim}No posse/* branches found.${C.reset}\n`);
      return;
    }

    const allWIs = listWorkItems();
    const wiByBranch = new Map();
    for (const wi of allWIs) {
      if (wi?.branch_name) wiByBranch.set(wi.branch_name, wi);
    }

    const mergedBranches = new Set();
    try {
      const raw = gitExec(["branch", "--merged", resolvedTargetBranch, "--list", "posse/*"], projectDir).trim();
      if (raw) raw.split("\n").forEach(b => mergedBranches.add(b.trim().replace(/^\*\s*/, "")));
    } catch {
      // best effort
    }

    const isDiffEmptyAgainstTarget = (branch) => {
      try {
        gitExec(["diff", "--quiet", `${resolvedTargetBranch}...${branch}`], projectDir);
        return true;
      } catch {
        return false;
      }
    };

    const merged = [];
    const unmerged = [];
    const mergeReasons = new Map();
    for (const branch of branches) {
      const wi = wiByBranch.get(branch);
      const dbMerged = wi?.merge_state === "merged";
      const gitMerged = mergedBranches.has(branch);
      const diffEmpty = !dbMerged && !gitMerged ? isDiffEmptyAgainstTarget(branch) : false;
      if (dbMerged || gitMerged || diffEmpty) {
        merged.push(branch);
        mergeReasons.set(branch, dbMerged ? "db" : (gitMerged ? "ancestor" : "empty-diff"));
      } else {
        unmerged.push(branch);
      }
    }

    if (unmerged.length === 0 && merged.length === 0) {
      console.log(`  ${C.dim}No posse/* branches to purge.${C.reset}\n`);
      return;
    }

    for (const branch of unmerged) {
      console.log(`  ${C.red}x ${branch}${C.reset} ${C.dim}(unmerged)${C.reset}`);
    }
    for (const branch of merged) {
      const reason = mergeReasons.get(branch) || "merged";
      console.log(`  ${C.green}+ ${branch}${C.reset} ${C.dim}(merged - stale, via ${reason})${C.reset}`);
    }

    const total = unmerged.length + merged.length;
    console.log(`\n  ${C.yellow}This will delete ${total} branch(es), their worktrees, and clear DB branch info for successful cleanups.${C.reset}`);

    const answer = await ask(`  Proceed? (y/N) `);
    if (answer.toLowerCase() !== "y") {
      console.log(`  ${C.dim}Aborted.${C.reset}\n`);
      return;
    }
    if (refuseIfSchedulerLive("purge")) return;

    const wiBranch = new Map();
    for (const wi of allWIs) {
      if (wi.branch_name) wiBranch.set(wi.branch_name, wi);
    }

    let purged = 0;
    let failed = 0;
    const allBranches = [...unmerged, ...merged];

    for (const branch of allBranches) {
      const wi = wiBranch.get(branch);

      if (wi) {
        const cleanupOk = await Promise.resolve(cleanupBranch(wi, { clearMergeState: true }));
        if (cleanupOk) {
          console.log(`  ${C.green}+${C.reset} Purged ${branch} (WI#${wi.id}: ${wi.title.slice(0, 40)})`);
          purged += 1;
        } else {
          failed += 1;
          console.log(`  ${C.yellow}!${C.reset} Could not purge ${branch}; WI#${wi.id} branch metadata was kept`);
        }
      } else {
        let worktreesRemoved = true;
        for (const wtPath of branchWorktreePaths(branch, projectDir)) {
          if (!removeWorktree(wtPath, projectDir)) worktreesRemoved = false;
        }
        const deleteResult = deleteBranchPreservingTip(projectDir, branch, {
          targetBranch: resolvedTargetBranch,
          reason: "orphan-branch-purge",
        });
        const branchDeleted = deleteResult.ok;
        const branchStillExists = branchExists(branch, projectDir);
        if (!worktreesRemoved || !branchDeleted || branchStillExists) {
          failed += 1;
          console.log(`  ${C.yellow}!${C.reset} Could not purge ${branch} (orphan; no WI in DB)`);
          continue;
        }
        purged += 1;
        console.log(`  ${C.green}+${C.reset} Purged ${branch} (orphan - no WI in DB)`);
      }
    }

    try {
      gitExec(["worktree", "prune"], projectDir);
    } catch {
      // best effort
    }

    if (failed > 0) {
      console.log(`\n  ${C.yellow}Purged ${purged}/${allBranches.length} branch(es); ${failed} failed.${C.reset} Failed branches were left in place.\n`);
    } else {
      console.log(`\n  ${C.green}Purged ${purged} branch(es).${C.reset} Worktrees cleaned, DB branch info cleared.\n`);
    }
  }

  async function cleanup(argv = process.argv) {
    if (refuseIfSchedulerLive("cleanup")) return;
    const force = argv.includes("--force");
    const autoMode = argv.includes("--auto");
    const dryRun = argv.includes("--dry-run");
    const resolvedTargetBranch = resolveMaintenanceTargetBranch("cleanup");

    console.log(`\n  ${C.bold}Cleanup triage${C.reset}${dryRun ? ` ${C.dim}(dry-run)${C.reset}` : ""}\n`);

    const inventory = buildInventory(projectDir, resolvedTargetBranch);
    const summary = inventorySummary(inventory);
    console.log(`  ${C.dim}Inventory: ${summary.snapshots} snapshots . ${summary.branches} branches . ${summary.worktrees} worktrees . ${summary.mainTreeDirty} main-tree dirty . ${summary.stashes} stashes${C.reset}\n`);

    if (inventoryIsEmpty(inventory)) {
      console.log(`  ${C.green}Nothing to clean up.${C.reset}\n`);
      return;
    }

    process.stdout.write(`  ${C.dim}Classifying...${C.reset} `);
    const { classifications, via } = await triageInventory(inventory);
    console.log(`${C.dim}(${via})${C.reset}\n`);

    const items = buildItemIndex(inventory);
    const byTier = { "safe-discard": [], "restore-suggested": [], "investigate": [] };
    for (const item of items) {
      const cls = classifications[item.key] || { tier: "investigate", reason: "unclassified", suggested_action: "inspect" };
      byTier[cls.tier].push({ item, cls });
    }

    const kindLabel = (kind) => ({
      snapshot: "recovery snapshot",
      branch: "branch",
      worktree: "worktree",
      main_tree: "main-tree dirt",
      stash: "stash",
    })[kind] || kind;

    const itemLabel = (item) => {
      if (item.kind === "snapshot") {
        const storage = item.payload.storageType === "git-ref" ? "ref" : (item.payload.storageType === "branch-ref" ? "branch-ref" : "dir");
        return `${item.payload.id} ${C.dim}(${storage}, ${item.payload.ageHuman}, WI#${item.payload.wiId ?? "?"})${C.reset}`;
      }
      if (item.kind === "branch") return `${item.payload.name} ${C.dim}(WI#${item.payload.wiId ?? "?"}, status=${item.payload.wiStatus ?? "?"}, merge=${item.payload.mergeState ?? "?"}${item.payload.mergedToTarget ? ", merged-to-target" : ""})${C.reset}`;
      if (item.kind === "worktree") return `${item.payload.path} ${C.dim}(WI#${item.payload.wiId ?? "?"}, ${item.payload.wiMissing ? "no WI row" : item.payload.wiStatus}${item.payload.hasChanges ? ", dirty" : ""})${C.reset}`;
      if (item.kind === "main_tree") return `${item.payload.fileCount} file(s) in ${projectDir}`;
      if (item.kind === "stash") return `${item.payload.ref} ${C.dim}(${item.payload.label.slice(0, 60)})${C.reset}`;
      return item.key;
    };

    for (const tier of ["safe-discard", "restore-suggested", "investigate"]) {
      const entries = byTier[tier];
      if (entries.length === 0) continue;
      const color = tier === "safe-discard" ? C.green : tier === "restore-suggested" ? C.yellow : C.cyan;
      console.log(`  ${color}${C.bold}${tier}${C.reset} ${C.dim}(${entries.length})${C.reset}`);
      for (const { item, cls } of entries) {
        console.log(`    ${color}.${C.reset} ${kindLabel(item.kind)}: ${itemLabel(item)}`);
        console.log(`      ${C.dim}${cls.reason}${C.reset}`);
      }
      console.log("");
    }

    if (dryRun) {
      console.log(`  ${C.dim}Dry-run: no actions taken.${C.reset}\n`);
      return;
    }

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    const runAction = (item, action, note = "") => {
      try {
        const result = applyAction({ kind: item.kind, payload: item.payload, action, projectDir, force });
        if (result.skipped) {
          skipped += 1;
          console.log(`      ${C.dim}skipped: ${result.reason}${C.reset}`);
        } else {
          applied += 1;
          console.log(`      ${C.green}+ ${action}${note ? ` - ${note}` : ""}${C.reset}`);
        }
      } catch (err) {
        failed += 1;
        console.log(`      ${C.red}x ${action} failed: ${err.message}${C.reset}`);
      }
    };

    if (autoMode) {
      const safe = byTier["safe-discard"];
      if (safe.length === 0) {
        console.log(`  ${C.dim}--auto: no safe-discard items.${C.reset}\n`);
      } else {
        console.log(`  ${C.yellow}--auto: discarding ${safe.length} safe-discard item(s)${C.reset}\n`);
        const confirm = (await ask(`  Proceed with --auto discard of ${safe.length} item(s)? (y/N): `)).trim().toLowerCase();
        if (confirm !== "y" && confirm !== "yes") {
          console.log(`  ${C.dim}Canceled. No cleanup actions taken.${C.reset}\n`);
          return;
        }
        if (refuseIfSchedulerLive("cleanup")) return;
        console.log("");
        for (const { item } of safe) {
          console.log(`    ${kindLabel(item.kind)}: ${itemLabel(item)}`);
          runAction(item, "discard");
        }
      }
      console.log(`\n  ${applied} applied . ${skipped} skipped . ${failed} failed\n`);
      return;
    }

    console.log(`  ${C.bold}Per-item review${C.reset} ${C.dim}(k=keep, d=discard, r=restore, a=apply-diff, s=skip, q=quit)${C.reset}\n`);
    for (const tier of ["safe-discard", "restore-suggested", "investigate"]) {
      for (const { item, cls } of byTier[tier]) {
        console.log(`  ${kindLabel(item.kind)}: ${itemLabel(item)}`);
        console.log(`  ${C.dim}tier=${cls.tier} suggested=${cls.suggested_action} reason: ${cls.reason}${C.reset}`);
        const answer = (await ask("    [k/d/r/a/s/q] ")).trim().toLowerCase();
        if (answer === "q") {
          console.log(`\n  ${C.dim}Quit. ${applied} applied . ${skipped} skipped . ${failed} failed${C.reset}\n`);
          return;
        }
        if (answer === "k" || answer === "s" || answer === "") {
          skipped += 1;
          continue;
        }
        if ((answer === "d" || answer === "r" || answer === "a") && refuseIfSchedulerLive("cleanup")) return;
        if (answer === "d") runAction(item, "discard");
        else if (answer === "r") {
          if (item.kind === "snapshot") {
            const isDirSnapshot = item.payload.storageType !== "git-ref";
            const destDir = path.join(projectDir, ".posse", "restored-snapshots");
            if (isDirSnapshot) fs.mkdirSync(destDir, { recursive: true });
            try {
              const result = applyAction({
                kind: "snapshot",
                payload: item.payload,
                action: "restore",
                projectDir,
                restoreDir: isDirSnapshot ? destDir : null,
              });
              applied += 1;
              console.log(`      ${C.green}+ restored ${item.payload.storageType === "git-ref" ? "into worktree" : `to ${result.path}`}${C.reset}`);
            } catch (err) {
              failed += 1;
              console.log(`      ${C.red}x restore failed: ${err.message}${C.reset}`);
            }
          } else if (item.kind === "stash") {
            runAction(item, "restore", "applied to working tree");
          } else {
            skipped += 1;
            console.log(`      ${C.dim}restore not supported for ${item.kind}; skipped${C.reset}`);
          }
        } else if (answer === "a") {
          if (item.kind === "snapshot") {
            try {
              const result = applyAction({
                kind: "snapshot",
                payload: item.payload,
                action: "apply-diff",
                projectDir,
              });
              applied += 1;
              if (result.branch) {
                console.log(`      ${C.green}+ applied diff on branch ${result.branch}${C.reset}`);
              } else {
                console.log(`      ${C.green}+ applied diff into working tree${C.reset}`);
              }
            } catch (err) {
              failed += 1;
              console.log(`      ${C.red}x apply-diff failed: ${err.message}${C.reset}`);
            }
          } else {
            skipped += 1;
            console.log(`      ${C.dim}apply-diff not supported for ${item.kind}; skipped${C.reset}`);
          }
        } else {
          skipped += 1;
          console.log(`      ${C.dim}unrecognized; skipped${C.reset}`);
        }
        console.log("");
      }
    }

    console.log(`  ${applied} applied . ${skipped} skipped . ${failed} failed\n`);
  }

  return { clear, prune, purge, cleanup };
}
