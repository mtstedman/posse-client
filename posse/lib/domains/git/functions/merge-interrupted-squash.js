// lib/domains/git/functions/merge-interrupted-squash.js
// Deterministic repair of a merge interrupted while its gate ran.
//
// The merge gate runs its checks with the squash staged in the target
// checkout. A thread timeout, crash or Ctrl-C there ends the worker without
// its finally blocks: the squash stays staged and the temporary candidate
// checkouts stay registered. Every later merge is then refused as dirty, and
// a merge-recovery `commit` answer or startup_dirty_tree_policy=commit would
// commit a candidate whose gate never finished. The merge writes a marker
// just before `merge --squash` and removes it on every exit, so a marker on
// disk means the gate was interrupted; recovery unstages that squash (after a
// snapshot) unless its commit already landed, then removes the temporary
// checkouts.

import fs from "fs";
import os from "os";
import path from "path";
import {
  MERGE_CANDIDATE_CHECKOUT_PREFIX,
  MERGE_CLOSEOUT_WORKTREE_PREFIX,
  MERGE_IN_PROGRESS_MARKER,
} from "../../../catalog/verification.js";
import { firstGitLine } from "./workflow-git-utils.js";

function gitPathFor(exec, cwd, name) {
  const relative = exec(["rev-parse", "--git-path", name], cwd);
  return path.isAbsolute(relative) ? relative : path.resolve(cwd, relative);
}

export function mergeInProgressMarkerPath(exec, cwd) {
  try {
    return gitPathFor(exec, cwd, MERGE_IN_PROGRESS_MARKER);
  } catch {
    return null;
  }
}

export function readMergeInProgressMarker(exec, cwd) {
  const markerPath = mergeInProgressMarkerPath(exec, cwd);
  if (!markerPath || !fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeMergeInProgressMarker(exec, cwd, record) {
  const markerPath = mergeInProgressMarkerPath(exec, cwd);
  if (!markerPath) throw new Error("could not resolve the merge-in-progress marker path");
  fs.writeFileSync(markerPath, `${JSON.stringify({ ...record, written_at: new Date().toISOString() })}\n`, "utf8");
  return markerPath;
}

export function removeMergeInProgressMarker(exec, cwd) {
  const markerPath = mergeInProgressMarkerPath(exec, cwd);
  if (markerPath) fs.rmSync(markerPath, { force: true });
}

function lines(exec, cwd, args) {
  return String(exec(args, cwd) || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function realpathOrSelf(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// mkdtemp appends six characters to the prefix.
function isMkdtempName(name, prefix) {
  return name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length));
}

// The temporary checkouts a merge registers, both detached:
// <tmp>/posse-merge-check-XXXXXX/candidate and <tmp>/posse-closeout-XXXXXX.
// Only linked worktrees of this repository (never its main worktree) whose
// holder directory sits directly in the OS temp directory qualify.
export function temporaryMergeWorktrees(exec, cwd) {
  const tempRoot = realpathOrSelf(os.tmpdir());
  const listing = String(exec(["worktree", "list", "--porcelain"], cwd, { trim: false }) || "");
  const blocks = listing.split(/\n\s*\n/).map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
    .filter((block) => block[0]?.startsWith("worktree "));
  const found = [];
  for (const block of blocks.slice(1)) {
    if (!block.includes("detached")) continue;
    const worktree = block[0].slice("worktree ".length).trim();
    const base = path.basename(worktree);
    const parent = path.dirname(worktree);
    const holder = base === "candidate" && isMkdtempName(path.basename(parent), MERGE_CANDIDATE_CHECKOUT_PREFIX)
      ? parent
      : isMkdtempName(base, MERGE_CLOSEOUT_WORKTREE_PREFIX) ? worktree : null;
    if (!holder || realpathOrSelf(path.dirname(holder)) !== tempRoot) continue;
    found.push({ worktree, holder });
  }
  return found;
}

export function removeTemporaryMergeWorktrees(exec, cwd) {
  const removed = [];
  let entries = [];
  try {
    entries = temporaryMergeWorktrees(exec, cwd);
  } catch {
    return removed;
  }
  for (const { worktree, holder } of entries) {
    try { exec(["worktree", "remove", "--force", worktree], cwd); } catch { /* pruned below */ }
    fs.rmSync(holder, { recursive: true, force: true });
    removed.push(worktree);
  }
  if (removed.length > 0) {
    try { exec(["worktree", "prune"], cwd); } catch { /* best effort */ }
  }
  return removed;
}

/**
 * Repair the target checkout after an interrupted merge gate. Returns
 * { action, marker, removedWorktrees, snapshotRef?, error? } where action is
 * none (no marker), unstaged, commit_kept, nothing_staged, head_moved, or
 * failed (the marker stays so later guards still refuse to commit).
 */
export function recoverInterruptedSquash({ cwd, exec, preserveSnapshot = null, log = () => {} } = {}) {
  const marker = readMergeInProgressMarker(exec, cwd);
  const result = { action: "none", marker, removedWorktrees: [] };
  if (marker) {
    try {
      const head = exec(["rev-parse", "HEAD"], cwd);
      const preMergeHead = String(marker.pre_merge_head || "");
      const squashMessage = gitPathFor(exec, cwd, "SQUASH_MSG");
      if (head === preMergeHead) {
        const staged = lines(exec, cwd, ["diff", "--cached", "--name-only"]);
        const unmerged = lines(exec, cwd, ["diff", "--name-only", "--diff-filter=U"]);
        if (staged.length > 0 || unmerged.length > 0) {
          // The working tree may hold edits made after the interrupt; keep a
          // copy before resetting the index.
          let snapshotRef = null;
          if (typeof preserveSnapshot === "function") {
            snapshotRef = preserveSnapshot(cwd, marker);
            if (!snapshotRef) throw new Error("snapshot of the interrupted squash was not written");
            result.snapshotRef = String(snapshotRef?.refName || snapshotRef?.snapshotPath || snapshotRef);
          }
          exec(["reset", "--merge"], cwd);
          result.action = "unstaged";
          result.stagedFiles = staged.slice(0, 50);
        } else {
          result.action = "nothing_staged";
        }
        fs.rmSync(squashMessage, { force: true });
      } else {
        let parent = "";
        let subject = "";
        try { parent = exec(["rev-parse", "HEAD^"], cwd); } catch { parent = ""; }
        try { subject = exec(["show", "-s", "--format=%s", "HEAD"], cwd); } catch { subject = ""; }
        // The gate passed and its commit landed before the interrupt.
        if (parent && parent === preMergeHead && marker.subject && subject === marker.subject) {
          result.action = "commit_kept";
          fs.rmSync(squashMessage, { force: true });
        } else {
          result.action = "head_moved";
        }
      }
      removeMergeInProgressMarker(exec, cwd);
    } catch (error) {
      result.action = "failed";
      result.error = firstGitLine(error);
    }
  }
  result.removedWorktrees = removeTemporaryMergeWorktrees(exec, cwd);
  if (result.action !== "none" || result.removedWorktrees.length > 0) {
    const what = {
      unstaged: `unstaged the squash of ${marker?.branch || "a work-item branch"} left by an interrupted merge gate`,
      commit_kept: `kept the squash commit of ${marker?.branch || "a work-item branch"} that landed before the interrupt`,
      nothing_staged: "cleared an interrupted merge marker with nothing staged",
      head_moved: "cleared an interrupted merge marker; the target head has moved since",
      failed: `could not repair an interrupted merge gate (${result.error})`,
      none: "removed temporary merge checkouts",
    }[result.action];
    try {
      log(`Merge recovery ${what}`, {
        json: {
          interrupted_merge_recovery: result.action,
          branch: marker?.branch || null,
          target: marker?.target || null,
          pre_merge_head: marker?.pre_merge_head || null,
          work_item_id: marker?.wi_id ?? null,
          snapshot_ref: result.snapshotRef || null,
          staged_files: result.stagedFiles || [],
          removed_worktrees: result.removedWorktrees,
          error: result.error || null,
        },
      });
    } catch { /* logging is observational */ }
  }
  return result;
}
