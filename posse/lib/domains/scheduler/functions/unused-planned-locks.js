import { getDb } from "../../../shared/storage/functions/index.js";
import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { worktreePathAsync } from "../../git/functions/worktree-path.js";
import { withBranchLockAsync, withWorktreeLockAsync } from "../../git/functions/worktree-locks.js";
import { releaseWorkItemFileLockForPath } from "../../queue/functions/file-locks.js";

// Narrow only after assessment has completed, not merely after a dev commit:
// queued assessment/fix work still owns its planned scope. The remaining locks
// protect the entire committed branch diff until merge, including both sides
// of renames. Root locks stay conservative.
export async function releaseUnusedCompletedWorkItemLocks(projectDir, {
  resolveWorktree = worktreePathAsync,
} = {}) {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT wi.* FROM work_items wi
    WHERE wi.status = 'complete' AND COALESCE(wi.merge_state, '') != 'merged'
      AND wi.branch_name IS NOT NULL AND wi.merge_base_hash IS NOT NULL
      AND EXISTS (SELECT 1 FROM work_item_file_locks l
        WHERE l.work_item_id = wi.id AND l.released_at IS NULL AND l.lock_kind = 'file')
  `).all();
  let released = 0;
  const settled = (wi) => {
    const fresh = db.prepare("SELECT * FROM work_items WHERE id = ?").get(wi.id);
    if (fresh?.status !== "complete" || fresh.merge_state === "merged"
      || fresh.branch_name !== wi.branch_name || fresh.merge_base_hash !== wi.merge_base_hash) return false;
    return !db.prepare("SELECT job_type, status FROM jobs WHERE work_item_id = ?").all(wi.id)
      .some(job => MUTATING_JOB_TYPES.has(job.job_type) && !["succeeded", "canceled"].includes(job.status));
  };
  for (const wi of candidates) {
    if (!settled(wi)) continue;
    try {
      const cwd = await resolveWorktree(projectDir, wi.id);
      await withWorktreeLockAsync(cwd, projectDir, () => withBranchLockAsync(cwd, wi.branch_name, projectDir, async () => {
        if (!settled(wi)) return;
        // Lock paths are project-relative. Decline ambiguous nested checkouts
        // until both the project and worktree roots are proven identical.
        if (String(await gitExecAsync(["rev-parse", "--show-prefix"], projectDir)).trim()
          || String(await gitExecAsync(["rev-parse", "--show-prefix"], cwd)).trim()) return;
        if (String(await gitExecAsync(["status", "--porcelain", "--untracked-files=all"], cwd)).trim()) return;
        if (String(await gitExecAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim() !== wi.branch_name) return;
        const head = String(await gitExecAsync(["rev-parse", "HEAD"], cwd)).trim();
        const branchHead = String(await gitExecAsync(["rev-parse", "--verify", `refs/heads/${wi.branch_name}`], cwd)).trim();
        if (head !== branchHead) return;
        await gitExecAsync(["merge-base", "--is-ancestor", wi.merge_base_hash, head], cwd);
        const changed = new Set(String(await gitExecAsync([
          "diff", "--name-only", "--no-renames", "-z", wi.merge_base_hash, head, "--",
        ], cwd, { trim: false })).split("\0").filter(Boolean));
        // No awaits between the final queue check and releases. A new fix or
        // replan invalidates the proof; later writers reacquire ordinary locks.
        db.transaction(() => {
          if (!settled(wi)) return;
          for (const lock of db.prepare(`SELECT path FROM work_item_file_locks
            WHERE work_item_id = ? AND released_at IS NULL AND lock_kind = 'file'`).all(wi.id)) {
            if (!changed.has(lock.path)) released += releaseWorkItemFileLockForPath(wi.id, lock.path, "file", "completed_branch_path_unchanged");
          }
        })();
      }, { waitMs: 50, pollMs: 5 }), { waitMs: 50, pollMs: 5 });
    } catch {
      // Missing/dirty worktrees, unavailable Git, and competing branch owners
      // provide no proof that a lock is redundant. Retain the claim.
    }
  }
  return released;
}
