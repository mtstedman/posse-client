// lib/cleanup/actions.js
//
// Confirmed mutations for cleanup. Each handler takes a single item and acts on
// it: discard (destructive), restore (copy-out), keep/inspect (print). Uses
// existing git helpers so logic stays DRY. No LLM; no survey logic.

import fs from "fs";
import path from "path";
import { slugify } from "../../../shared/format/functions/slug.js";
import { gitExec } from "../../git/functions/utils.js";
import { deleteBranchPreservingTip, worktreeRoot } from "../../git/functions/worktree.js";
import { SNAPSHOT_REF_PREFIX } from "../../git/functions/worktree-snapshots.js";
import { TERMINAL_JOB_STATUSES, TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { getLiveSchedulerBlockMessage, listJobsByWorkItem, logEvent } from "../../queue/functions/index.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
function assertSafeWorkItemDiscard(payload = {}, kind, { force = false } = {}) {
  if (force) return;
  const schedulerMessage = getLiveSchedulerBlockMessage("main");
  if (schedulerMessage) {
    throw new Error(`${kind} discard refused: ${schedulerMessage}; pass --force to override`);
  }

  const wiId = payload?.wiId;
  if (wiId == null) return;
  if (payload?.wiStatus && !TERMINAL_WORK_ITEM_STATUS_SET.has(payload.wiStatus)) {
    throw new Error(`${kind} discard refused: WI#${wiId} is ${payload.wiStatus}; pass --force to override`);
  }

  let jobs = [];
  try {
    jobs = listJobsByWorkItem(wiId);
  } catch (err) {
    throw new Error(`${kind} discard refused: unable to verify WI#${wiId} job state (${err?.message || err}); pass --force to override`);
  }
  const active = jobs.filter((job) => !TERMINAL_JOB_STATUS_SET.has(job.status));
  if (active.length > 0) {
    const first = active[0];
    throw new Error(`${kind} discard refused: WI#${wiId} has active job #${first.id} (${first.status}); pass --force to override`);
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function managedSnapshotRoot(projectDir) {
  if (!projectDir) throw new Error("directory snapshot action requires projectDir");
  return path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
}

function assertManagedDirectorySnapshotPath(snapshot, projectDir, actionLabel) {
  if (!snapshot?.path) throw new Error("snapshot payload missing path");
  const root = managedSnapshotRoot(projectDir);
  const targetPath = path.resolve(snapshot.path);
  if (!isInsideRoot(targetPath, root, { allowEqual: false })) {
    throw new Error(`${actionLabel} refused: snapshot path outside managed recovery root ${root}: ${targetPath}`);
  }
  return targetPath;
}

function assertManagedSnapshotRefName(snapshot, actionLabel) {
  const refName = String(snapshot?.refName || "").trim();
  if (!refName) throw new Error("snapshot payload missing refName");
  if (!refName.startsWith(`${SNAPSHOT_REF_PREFIX}/`)) {
    throw new Error(`${actionLabel} refused: ref outside snapshot namespace ${SNAPSHOT_REF_PREFIX}: ${refName}`);
  }
  return refName;
}

function assertRestoreTarget(snapshot, restoreDir) {
  if (!restoreDir) throw new Error("directory snapshot restore requires restoreDir");
  const restoreRoot = path.resolve(restoreDir);
  const target = path.resolve(restoreRoot, String(snapshot?.id || ""));
  if (!isInsideRoot(target, restoreRoot, { allowEqual: false })) {
    throw new Error(`snapshot restore refused: restore target outside ${restoreRoot}: ${target}`);
  }
  return target;
}

export function discardSnapshot(snapshot, projectDir = snapshot?.projectDir) {
  if ((snapshot.storageType === "git-ref" || snapshot.storageType === "branch-ref") && snapshot.refName) {
    const refName = assertManagedSnapshotRefName(snapshot, "snapshot discard");
    try {
      gitExec(["update-ref", "-d", refName], projectDir || process.cwd());
    } catch (err) {
      throw new Error(`git update-ref -d ${refName} failed: ${err.message.split("\n")[0]}`);
    }
  } else if (snapshot.path) {
    fs.rmSync(assertManagedDirectorySnapshotPath(snapshot, projectDir, "snapshot discard"), { recursive: true, force: true });
  } else {
    throw new Error("snapshot payload missing refName/path");
  }
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_SNAPSHOT_DISCARDED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Discarded recovery snapshot ${snapshot.id}`,
    event_json: JSON.stringify({
      path: snapshot.path || null,
      ref_name: snapshot.refName || null,
      reason: snapshot.reason,
      wi_id: snapshot.wiId,
    }),
  });
  return { ok: true, path: snapshot.path || snapshot.refName };
}

function restoreBranchRefSnapshot(snapshot, projectDir) {
  const repoDir = projectDir || snapshot.projectDir || process.cwd();
  if (snapshot.refName) assertManagedSnapshotRefName(snapshot, "snapshot restore");
  const source = snapshot.refName || snapshot.objectHash;
  if (!source) throw new Error("branch snapshot payload missing refName/objectHash");

  const branchBase = safeBranchName(`posse/recovery/${snapshot.id || "branch-snapshot"}`);
  let branchName = null;
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? branchBase : `${branchBase}-${i + 1}`;
    try {
      gitExec(["checkout", "-b", candidate, source], repoDir);
      branchName = candidate;
      break;
    } catch (err) {
      if (i === 4) throw new Error(`failed to create restore branch from ${source}: ${err.message.split("\n")[0]}`);
    }
  }

  logEvent({
    event_type: EVENT_TYPES.CLEANUP_BRANCH_SNAPSHOT_RESTORED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Restored branch snapshot ${snapshot.id} to ${branchName}`,
    event_json: JSON.stringify({ ref_name: snapshot.refName, branch: branchName }),
  });
  return { ok: true, path: `branch:${branchName}`, branch: branchName };
}

export function restoreSnapshot(snapshot, destDir, projectDir = snapshot?.projectDir) {
  if (snapshot.storageType === "branch-ref") {
    return restoreBranchRefSnapshot(snapshot, projectDir || process.cwd());
  }

  if (snapshot.storageType === "git-ref" && snapshot.refName) {
    const refName = assertManagedSnapshotRefName(snapshot, "snapshot restore");
    try {
      gitExec(["stash", "apply", "--index", refName], projectDir || process.cwd());
    } catch (err) {
      throw new Error(`git stash apply ${refName} failed: ${err.message.split("\n")[0]}`);
    }
    logEvent({
      event_type: EVENT_TYPES.CLEANUP_SNAPSHOT_RESTORED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Applied snapshot ${snapshot.id} from ${refName}`,
      event_json: JSON.stringify({ ref_name: refName }),
    });
    return { ok: true, path: `applied:${refName}` };
  }

  const source = assertManagedDirectorySnapshotPath(snapshot, projectDir, "snapshot restore");
  const target = assertRestoreTarget(snapshot, destDir);
  if (fs.existsSync(target)) throw new Error(`restore target already exists: ${target}`);
  copyDirRecursive(source, target);
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_SNAPSHOT_RESTORED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Copied snapshot ${snapshot.id} to ${target}`,
    event_json: JSON.stringify({ source, dest: target }),
  });
  return { ok: true, path: target };
}

function actionablePorcelainPaths(repoDir) {
  const porcelain = gitExec(["status", "--porcelain"], repoDir);
  return String(porcelain || "")
    .split("\n")
    .map((line) => String(line || ""))
    .filter(Boolean)
    .flatMap((line) => porcelainLinePaths(line))
    .filter((relPath) => relPath
      && !relPath.startsWith(".posse/")
      && !relPath.startsWith(".posse-worktrees/")
      && !relPath.startsWith(".posse-test-suites/"));
}

function unquotePorcelainPath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\").replace(/\\/g, "/");
  }
  return trimmed.replace(/\\/g, "/");
}

function porcelainLinePaths(line) {
  const token = String(line || "").slice(3).trim();
  const renameSep = " -> ";
  const sepIndex = token.indexOf(renameSep);
  if (sepIndex === -1) return [unquotePorcelainPath(token)];
  return [
    unquotePorcelainPath(token.slice(0, sepIndex)),
    unquotePorcelainPath(token.slice(sepIndex + renameSep.length)),
  ];
}

function assertCleanForSnapshotDiff(repoDir) {
  if (actionablePorcelainPaths(repoDir).length > 0) {
    throw new Error("working tree is not clean; commit/stash current changes before apply-diff");
  }
}

function snapshotApplyRollbackState(repoDir) {
  const head = gitExec(["rev-parse", "HEAD"], repoDir);
  let branch = null;
  try {
    branch = gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], repoDir);
  } catch {
    branch = null;
  }
  return { head, branch };
}

function rollbackSnapshotDiffApply(repoDir, state, { createdBranch = null } = {}) {
  try { gitExec(["reset", "--hard", state.head], repoDir); } catch { /* best effort */ }
  try { gitExec(["clean", "-fd"], repoDir); } catch { /* best effort */ }
  try {
    if (state.branch) gitExec(["checkout", state.branch], repoDir);
    else gitExec(["checkout", state.head], repoDir);
  } catch {
    // Leave the repo at the reset HEAD if checkout cannot be restored.
  }
  if (createdBranch && createdBranch !== state.branch) {
    try { gitExec(["branch", "-D", createdBranch], repoDir); } catch { /* best effort */ }
  }
}

export function applySnapshotDiff(snapshot, projectDir) {
  if (snapshot.storageType === "branch-ref") {
    return restoreBranchRefSnapshot(snapshot, projectDir);
  }

  if (snapshot.storageType === "git-ref" && snapshot.refName) {
    const repoDir = projectDir || snapshot.projectDir || process.cwd();
    const refName = assertManagedSnapshotRefName(snapshot, "snapshot apply-diff");
    assertCleanForSnapshotDiff(repoDir);
    const rollbackState = snapshotApplyRollbackState(repoDir);
    try {
      gitExec(["stash", "apply", "--index", refName], repoDir);
    } catch (err) {
      rollbackSnapshotDiffApply(repoDir, rollbackState);
      throw new Error(`git stash apply ${refName} failed: ${err.message.split("\n")[0]}`);
    }
    logEvent({
      event_type: EVENT_TYPES.CLEANUP_SNAPSHOT_DIFF_APPLIED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Applied snapshot ${snapshot.id} from ${refName}`,
      event_json: JSON.stringify({ ref_name: refName }),
    });
    return { ok: true, path: `applied:${refName}`, branch: null };
  }

  if (!snapshot.path) throw new Error("snapshot payload missing path");
  const repoDir = projectDir || snapshot.projectDir || process.cwd();
  const source = assertManagedDirectorySnapshotPath(snapshot, repoDir, "snapshot apply-diff");
  assertCleanForSnapshotDiff(repoDir);
  const rollbackState = snapshotApplyRollbackState(repoDir);

  const manifest = safeReadJson(path.join(source, "manifest.json")) || {};
  const stagedPatch = path.join(source, "staged.patch");
  const diffPatch = path.join(source, "diff.patch");
  const branchBase = safeBranchName(`posse/recovery/${snapshot.id || Date.now()}`);
  let branchName = branchBase;
  let createdBranch = null;
  const headSha = String(manifest.head_sha || "").trim();
  try {
    if (headSha) {
      for (let i = 0; i < 5; i++) {
        const candidate = i === 0 ? branchBase : `${branchBase}-${i + 1}`;
        try {
          gitExec(["checkout", "-b", candidate, headSha], repoDir);
          branchName = candidate;
          createdBranch = candidate;
          break;
        } catch (err) {
          if (i === 4) throw new Error(`failed to create restore branch from ${headSha}: ${err.message.split("\n")[0]}`);
        }
      }
    }

    let applied = 0;
    if (fs.existsSync(stagedPatch) && fs.statSync(stagedPatch).size > 0) {
      gitExec(["apply", "--3way", "--index", stagedPatch], repoDir);
      applied++;
    }
    if (fs.existsSync(diffPatch) && fs.statSync(diffPatch).size > 0) {
      gitExec(["apply", "--3way", diffPatch], repoDir);
      applied++;
    }
    if (applied === 0) throw new Error("snapshot contains no patch payload to apply");
  } catch (err) {
    rollbackSnapshotDiffApply(repoDir, rollbackState, { createdBranch });
    throw err;
  }

  logEvent({
    event_type: EVENT_TYPES.CLEANUP_SNAPSHOT_DIFF_APPLIED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Applied snapshot diff ${snapshot.id} to working tree`,
    event_json: JSON.stringify({ source, branch: branchName, head_sha: headSha || null }),
  });
  return { ok: true, path: source, branch: branchName };
}

function safeBranchName(name) {
  return slugify(name || "posse/recovery/snapshot", {
    alphabet: "path",
    fallback: "posse/recovery/snapshot",
    maxLength: 120,
    preserveCase: true,
  });
}

export function discardBranch(branch, projectDir, { force = false } = {}) {
  assertSafeWorkItemDiscard(branch, "branch", { force });
  const result = deleteBranchPreservingTip(projectDir, branch.name, {
    targetBranch: branch.targetBranch || undefined,
    reason: "cleanup-branch-discard",
    wiId: branch.wiId ?? null,
  });
  if (!result.ok) {
    const detail = result.error || result.reason || "unknown error";
    throw new Error(`delete branch ${branch.name} failed: ${String(detail).split("\n")[0]}`);
  }
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_BRANCH_DISCARDED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Deleted branch ${branch.name}${result.snapshotRef ? ` after saving tip to ${result.snapshotRef}` : ""}`,
    event_json: JSON.stringify({
      wi_id: branch.wiId,
      merged_to_target: branch.mergedToTarget,
      snapshot_ref: result.snapshotRef || null,
      delete_reason: result.reason,
    }),
  });
  return { ok: true, snapshotRef: result.snapshotRef || null };
}

export function discardWorktree(worktree, projectDir, { force = false } = {}) {
  assertSafeWorkItemDiscard(worktree, "worktree", { force });
  try {
    gitExec(["worktree", "remove", worktree.path, "--force"], projectDir);
  } catch {
    const worktreeBase = worktreeRoot(projectDir);
    const targetPath = path.resolve(worktree.path || "");
    if (!isInsideRoot(targetPath, worktreeBase, { allowEqual: false })) {
      try { gitExec(["worktree", "prune"], projectDir); } catch { /* ignore */ }
      throw new Error(`refusing to remove worktree outside ${worktreeBase}: ${targetPath}`);
    }
    try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { gitExec(["worktree", "prune"], projectDir); } catch { /* ignore */ }
  }
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_WORKTREE_DISCARDED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Removed worktree ${worktree.path}`,
    event_json: JSON.stringify({ wi_id: worktree.wiId, wi_status: worktree.wiStatus, had_changes: worktree.hasChanges }),
  });
  return { ok: true };
}

export function dropStash(stash, projectDir) {
  const ref = resolveCurrentStashRef(stash, projectDir, "drop");
  try {
    gitExec(["stash", "drop", ref], projectDir);
  } catch (err) {
    throw new Error(`git stash drop ${ref} failed: ${err.message.split("\n")[0]}`);
  }
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_STASH_DROPPED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Dropped stash ${ref}`,
    event_json: JSON.stringify({ label: stash.label, object_hash: stash.objectHash || null }),
  });
  return { ok: true };
}

export function restoreStash(stash, projectDir) {
  const ref = resolveCurrentStashRef(stash, projectDir, "apply");
  try {
    gitExec(["stash", "apply", ref], projectDir);
  } catch (err) {
    throw new Error(`git stash apply ${ref} failed: ${err.message.split("\n")[0]}`);
  }
  logEvent({
    event_type: EVENT_TYPES.CLEANUP_STASH_APPLIED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Applied stash ${ref} to working tree`,
    event_json: JSON.stringify({ label: stash.label, object_hash: stash.objectHash || null }),
  });
  return { ok: true };
}

function listCurrentStashes(projectDir) {
  const raw = gitExec(["stash", "list", "--format=%gd%x00%H"], projectDir);
  return String(raw || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, objectHash] = line.split("\0");
      return { ref, objectHash };
    })
    .filter((entry) => entry.ref && entry.objectHash);
}

function resolveCurrentStashRef(stash, projectDir, actionLabel) {
  const expectedHash = String(stash?.objectHash || "").trim();
  if (!expectedHash) return stash?.ref;
  const current = listCurrentStashes(projectDir);
  const hit = current.find((entry) => entry.objectHash === expectedHash);
  if (!hit) {
    throw new Error(`git stash ${actionLabel} refused: surveyed stash ${stash.ref} no longer matches the current stash stack`);
  }
  return hit.ref;
}

export function applyAction({ kind, payload, action, projectDir, restoreDir = null, force = false }) {
  switch (`${kind}:${action}`) {
    case "snapshot:discard":   return discardSnapshot(payload, projectDir);
    case "snapshot:restore":   return restoreSnapshot(payload, restoreDir, projectDir);
    case "snapshot:apply-diff": return applySnapshotDiff(payload, projectDir);
    case "branch:discard":     return discardBranch(payload, projectDir, { force });
    case "worktree:discard":   return discardWorktree(payload, projectDir, { force });
    case "stash:discard":      return dropStash(payload, projectDir);
    case "stash:restore":      return restoreStash(payload, projectDir);
    default:
      return { ok: false, skipped: true, reason: `no handler for ${kind}:${action}` };
  }
}
