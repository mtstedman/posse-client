import { WORKTREE_JOB_TYPES } from "../../../catalog/job.js";
import { listActiveFileLocks } from "../../queue/functions/index.js";
import { QUEUE_LOCKING_JOB_TYPES } from "../../../catalog/job.js";
import { HeldQueueLockIndex } from "../classes/HeldQueueLockIndex.js";
import { parseFileScope, scopeToSchedulerLocks } from "./file-scope.js";

// Both aliases happen to equal the same set today. Kept distinct so the
// "needs a worktree" and "takes a repo-root lock" concepts can diverge if a
// future job type needs one but not the other.
export const WORKTREE_TYPES = WORKTREE_JOB_TYPES;
export const ROOT_LOCKING_JOB_TYPES = WORKTREE_JOB_TYPES;

export function createHeldQueueLockIndex(opts = {}) {
  return new HeldQueueLockIndex(opts);
}

export function collectHeldQueueLocks(activeWorkers = new Map()) {
  const lockedFiles = new Set();
  const lockedRoots = new Set();
  const activeWorktreeWIs = new Set();
  const heldLocks = [];
  const seen = new Set();

  const rememberLock = (lock) => {
    if (!lock) return;
    const tier = lock.lock_tier || "job";
    const holder = lock.job_id != null
      ? `job:${lock.job_id}`
      : `wi:${lock.work_item_id ?? "?"}:lock:${lock.id ?? `${lock.acquired_at ?? "?"}:${lock.source_job_id ?? "?"}`}`;
    const key = `${tier}:${holder}:${lock.lock_kind}:${lock.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    heldLocks.push(lock);
    if (tier === "job" && WORKTREE_TYPES.has(lock.job_type)) activeWorktreeWIs.add(lock.work_item_id);
    if (lock.lock_kind === "file") lockedFiles.add(lock.path);
    if (ROOT_LOCKING_JOB_TYPES.has(lock.job_type) && lock.lock_kind === "root") lockedRoots.add(lock.path);
  };

  const activeLocks = listActiveFileLocks();

  for (const lock of activeLocks.work_items || []) {
    rememberLock({
      ...lock,
      lock_tier: "work_item",
      job_id: lock.source_job_id ?? lock.job_id ?? null,
      job_type: lock.source_job_type || lock.job_type || null,
    });
  }

  for (const lock of activeLocks.jobs || []) {
    rememberLock({ ...lock, lock_tier: "job" });
  }

  for (const [, entry] of activeWorkers) {
    const job = entry?.job;
    if (!job || !QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) continue;
    if (WORKTREE_TYPES.has(job.job_type)) activeWorktreeWIs.add(job.work_item_id);
    const scope = parseFileScope(job);
    const rows = (scope.files.length === 0 && scope.createRoots.length === 0)
      ? [{
        path: "*",
        lock_kind: "root",
        work_item_id: job.work_item_id,
        job_id: job.id,
        job_type: job.job_type,
      }]
      : scopeToSchedulerLocks(scope, job).map((lock) => ({ ...lock, job_type: job.job_type }));
    for (const row of rows) {
      rememberLock({ ...row, lock_tier: "job" });
    }
  }

  return { lockedFiles, lockedRoots, activeWorktreeWIs, heldLocks };
}
