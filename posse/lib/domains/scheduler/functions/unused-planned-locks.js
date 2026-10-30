import path from "node:path";
import { getDb } from "../../../shared/storage/functions/index.js";
import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { fingerprint as fingerprintPaths } from "../../git/functions/reviewed-destination-state.js";
import { worktreePathAsync } from "../../git/functions/worktree-path.js";
import { withBranchLockAsync, withWorktreeLockAsync } from "../../git/functions/worktree-locks.js";
import { releaseWorkItemFileLockForPath } from "../../queue/functions/file-locks.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";

// Last successful proof per work item. A cache invalidator only, never evidence:
// a sweep skips a WI whose branch head, merge base, lock set and git metadata
// are unchanged since the proof released everything releasable at that head.
// Entries leave with the WI (merged, canceled, no live file locks).
const provenStates = new Map();

export function __testResetUnusedPlannedLockProofs() {
  provenStates.clear();
}

function liveLockTuple(db, workItemId) {
  const row = db.prepare(`SELECT COUNT(*) AS n, MAX(acquired_at) AS latest FROM work_item_file_locks
    WHERE work_item_id = ? AND released_at IS NULL`).get(workItemId);
  return `${row?.n || 0}|${row?.latest || ""}`;
}

function proofUnchanged(db, wi, proven) {
  return proven
    && proven.branch_name === wi.branch_name
    && proven.merge_base_hash === wi.merge_base_hash
    && proven.locks === liveLockTuple(db, wi.id)
    && fingerprintPaths(proven.paths) === proven.fingerprint;
}

// Narrow only after assessment has completed, not merely after a dev commit:
// queued assessment/fix work still owns its planned scope. The remaining locks
// protect the entire committed branch diff until merge, including both sides
// of renames. Root locks stay conservative.
export async function releaseUnusedCompletedWorkItemLocks(projectDir, {
  resolveWorktree = worktreePathAsync,
  gitExec = gitExecAsync,
} = {}) {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT wi.* FROM work_items wi
    WHERE wi.status = 'complete' AND COALESCE(wi.merge_state, '') != 'merged'
      AND wi.branch_name IS NOT NULL AND wi.merge_base_hash IS NOT NULL
      AND EXISTS (SELECT 1 FROM work_item_file_locks l
        WHERE l.work_item_id = wi.id AND l.released_at IS NULL AND l.lock_kind = 'file')
  `).all();
  const candidateIds = new Set(candidates.map((wi) => wi.id));
  for (const id of provenStates.keys()) if (!candidateIds.has(id)) provenStates.delete(id);
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
    if (proofUnchanged(db, wi, provenStates.get(wi.id))) continue;
    provenStates.delete(wi.id);
    try {
      const cwd = await resolveWorktree(projectDir, wi.id);
      await withWorktreeLockAsync(cwd, projectDir, () => withBranchLockAsync(cwd, wi.branch_name, projectDir, async () => {
        if (!settled(wi)) return;
        // Lock paths are project-relative. Decline ambiguous nested checkouts
        // until both the project and worktree roots are proven identical.
        if (String(await gitExec(["rev-parse", "--show-prefix"], projectDir)).trim()
          || String(await gitExec(["rev-parse", "--show-prefix"], cwd)).trim()) return;
        // Ref metadata whose stat state pins this proof (captured before the
        // git reads below, so a concurrent commit invalidates the next sweep).
        // The index is deliberately absent: `git status` rewrites it, and
        // staged state can only block releases, never create new ones.
        const gitDir = String(await gitExec(["rev-parse", "--absolute-git-dir"], cwd)).trim();
        const commonDir = path.resolve(cwd, String(await gitExec(["rev-parse", "--git-common-dir"], cwd)).trim());
        const paths = [
          ...["HEAD", "commondir"].map((name) => path.join(gitDir, name)),
          path.join(commonDir, "packed-refs"), path.join(commonDir, "reftable", "tables.list"),
          path.join(commonDir, "refs", "heads", ...wi.branch_name.split("/")),
        ];
        const proofFingerprint = fingerprintPaths(paths);
        if (String(await gitExec(["status", "--porcelain", "--untracked-files=all"], cwd)).trim()) return;
        if (String(await gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim() !== wi.branch_name) return;
        const head = String(await gitExec(["rev-parse", "HEAD"], cwd)).trim();
        const branchHead = String(await gitExec(["rev-parse", "--verify", `refs/heads/${wi.branch_name}`], cwd)).trim();
        if (head !== branchHead) return;
        await gitExec(["merge-base", "--is-ancestor", wi.merge_base_hash, head], cwd);
        const changed = new Set(String(await gitExec([
          "diff", "--name-only", "--no-renames", "-z", wi.merge_base_hash, head, "--",
        ], cwd, { trim: false })).split("\0").filter(Boolean));
        // No awaits between the final queue check and releases. A new fix or
        // replan invalidates the proof; later writers reacquire ordinary locks.
        // Immediate transaction: the release's deferred wake emits flush on
        // commit, so the scheduler sees the freed paths this lap.
        runImmediateTransaction(db, () => {
          if (!settled(wi)) return;
          for (const lock of db.prepare(`SELECT path FROM work_item_file_locks
            WHERE work_item_id = ? AND released_at IS NULL AND lock_kind = 'file'`).all(wi.id)) {
            if (!changed.has(lock.path)) released += releaseWorkItemFileLockForPath(wi.id, lock.path, "file", "completed_branch_path_unchanged");
          }
          provenStates.set(wi.id, {
            head, branch_name: wi.branch_name, merge_base_hash: wi.merge_base_hash,
            locks: liveLockTuple(db, wi.id), paths, fingerprint: proofFingerprint,
          });
        });
      }, { waitMs: 50, pollMs: 5 }), { waitMs: 50, pollMs: 5 });
    } catch {
      // Missing/dirty worktrees, unavailable Git, and competing branch owners
      // provide no proof that a lock is redundant. Retain the claim.
    }
  }
  return released;
}
