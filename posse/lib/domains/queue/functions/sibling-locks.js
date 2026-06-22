import { listActiveFileLocks } from "./file-locks.js";
import { isUnderRoot } from "../../../shared/scope/functions/path.js";

function norm(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function activeSiblingWriteLocks(job = {}, locks = null) {
  const allLocks = locks || listActiveFileLocks();
  const jobLocks = Array.isArray(allLocks?.jobs) ? allLocks.jobs : [];
  const wiId = Number(job?.work_item_id);
  const jobId = Number(job?.id);
  if (!Number.isFinite(wiId)) return [];
  return jobLocks.filter((lock) => {
    if (Number(lock?.work_item_id) !== wiId) return false;
    if (Number.isFinite(jobId) && Number(lock?.job_id) === jobId) return false;
    return true;
  });
}

export function activeLiveSiblingWriteLocks(job = {}, locks = null) {
  return activeSiblingWriteLocks(job, locks).filter((lock) => lock?.job_status !== "queued");
}

export function hasActiveSiblingWriteLocks(job = {}, locks = null) {
  return activeSiblingWriteLocks(job, locks).length > 0;
}

export function siblingLockSummary(locks = [], limit = 5) {
  return locks
    .slice(0, limit)
    .map((lock) => `#${lock.job_id}:${lock.path}`)
    .join(", ");
}

export function findActiveSiblingLockForPath(file, job = {}, {
  locks = null,
  includeRootLocks = true,
} = {}) {
  const normalizedFile = norm(file);
  if (!normalizedFile) return null;
  for (const lock of activeSiblingWriteLocks(job, locks)) {
    const lockPath = norm(lock?.path);
    if (!lockPath) continue;
    if (lockPath === "*") return lock;
    if (lock.lock_kind === "file" && normalizedFile === lockPath) return lock;
    if (
      includeRootLocks
      && lock.lock_kind === "root"
      && lockPath !== "."
      && (normalizedFile === lockPath || isUnderRoot(normalizedFile, [lockPath]))
    ) {
      return lock;
    }
  }
  return null;
}
