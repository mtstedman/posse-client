import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExec } from "./utils.js";
import { refreshBranchForCloseout } from "./merge-closeout.js";
import { parseReviewedTreeObject, sameReviewedObject } from "./reviewed-file-objects.js";
import { REVIEWED_HANDOFF_TRAILER, REVIEWED_REFRESH_REF_PREFIX } from "../../../catalog/reviewed-handoffs.js";

// Runs off the scheduler thread. All writes are to a private worktree and a
// temporary ref; it never checks out, resets, or moves the receiver branch.
export function prepareReviewedTargetRefresh({ projectDir, branchHead, targetHead, settled, resultRef }) {
  if (![branchHead, targetHead].every((hash) => /^[a-f0-9]{40,64}$/.test(hash))
      || !resultRef?.startsWith(REVIEWED_REFRESH_REF_PREFIX)) throw new Error("Invalid reviewed refresh identity");
  const drops = new Set();
  for (const { transfer, mergeCommits } of settled) {
    const commit = transfer.sync_commit;
    if (!/^[a-f0-9]{40,64}$/.test(commit || "")) return { prepared: false, reason: "missing_sync_commit" };
    try {
      for (const merged of mergeCommits) gitExec(["merge-base", "--is-ancestor", merged, targetHead], projectDir);
      gitExec(["merge-base", "--is-ancestor", commit, branchHead], projectDir);
      const message = String(gitExec(["show", "-s", "--format=%B", commit], projectDir));
      // Already-present application records can point at an ordinary commit.
      // They authorize no drop; retain those commits in the normal replay.
      if (!message.split("\n").includes(`${REVIEWED_HANDOFF_TRAILER}: ${transfer.transfer_id}`)) continue;
      const parents = String(gitExec(["show", "-s", "--format=%P", commit], projectDir)).trim().split(/\s+/);
      if (parents.length !== 1 || (transfer.target_head && parents[0] !== transfer.target_head)) return { prepared: false, reason: "sync_parent_mismatch" };
      const changed = String(gitExec(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit], projectDir, { trim: false })).split("\0").filter(Boolean);
      if (!changed.length || changed.some((file) => !transfer.files.some((entry) => entry.repo_path === file))) return { prepared: false, reason: "sync_scope_mismatch" };
      for (const file of transfer.files) {
        const object = parseReviewedTreeObject(String(gitExec(["ls-tree", "--full-name", "-z", commit, "--", `:(top,literal)${file.repo_path}`], projectDir, { trim: false })), file.repo_path);
        if (!sameReviewedObject(object, file.object)) return { prepared: false, reason: "sync_object_mismatch" };
      }
    } catch { return { prepared: false, reason: "incomplete_git_proof" }; }
    drops.add(commit);
  }
  if (!drops.size) return { prepared: false, reason: "no_settled_copies" };
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "posse-reviewed-refresh-"));
  let added = false;
  try {
    gitExec(["worktree", "add", "--detach", worktree, branchHead], projectDir);
    added = true;
    const replay = refreshBranchForCloseout({ exec: gitExec, cwd: projectDir, branch: branchHead,
      targetBranch: targetHead, worktreePath: worktree, ownsWorktree: true,
      publishBranch: false, cleanReplayOnly: true, droppableSyncCommits: drops });
    if (!replay.refreshed || !replay.dropped.length) return { prepared: false, reason: replay.reason || "no_settled_copies" };
    const tree = String(gitExec(["rev-parse", `${replay.refreshedHead}^{tree}`], projectDir)).trim();
    // Keep receipt/copy commits in ancestry. Only the merge's resulting tree
    // comes from replay; future consumers can still prove the original history.
    const commit = String(gitExec(["commit-tree", tree, "-p", branchHead, "-p", targetHead,
      "-m", "posse: reconcile settled reviewed handoffs before development"], projectDir)).trim();
    gitExec(["update-ref", resultRef, commit, ""], projectDir);
    return { prepared: true, commit, branchHead, targetHead, dropped: replay.dropped };
  } finally {
    if (added) {
      try { gitExec(["worktree", "remove", "--force", worktree], projectDir); } catch { /* Private leftovers are recoverable; never touch the receiver. */ }
    } else fs.rmSync(worktree, { recursive: true, force: true });
  }
}
