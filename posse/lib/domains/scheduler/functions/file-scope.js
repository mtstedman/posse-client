import { getWorkItem } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { Scope } from "../../../shared/scope/classes/Scope.js";
import { isUnderRoot, normPath, rootsOverlap } from "../../worker/functions/helpers/scope.js";

export function normalizeSchedulerPath(p) {
  const normalized = normPath(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function parseFileScope(job) {
  const payload = parseJobPayload(job);
  const scope = Scope.fromPayload(payload, { cwd: process.cwd() });
  return { files: scope.allFiles(), createRoots: [...scope.createRoots], workItemId: job.work_item_id, jobId: job.id };
}

export function scopeToSchedulerLocks(jobScope, job = null) {
  const rows = [];
  for (const path of jobScope?.files || []) {
    rows.push({
      path,
      lock_kind: "file",
      work_item_id: job?.work_item_id ?? jobScope?.workItemId ?? null,
      job_id: job?.id ?? jobScope?.jobId ?? null,
    });
  }
  for (const path of jobScope?.createRoots || []) {
    rows.push({
      path,
      lock_kind: "root",
      work_item_id: job?.work_item_id ?? jobScope?.workItemId ?? null,
      job_id: job?.id ?? jobScope?.jobId ?? null,
    });
  }
  return rows;
}

function lockKind(lock) {
  return lock?.lock_kind || lock?.lockKind || lock?.kind || null;
}

function schedulerLocksConflict(lock, candidate) {
  const heldKind = lockKind(lock);
  const candidateKind = lockKind(candidate);
  if (candidateKind === "file" && heldKind === "file") return candidate.path === lock.path;
  if (candidateKind === "file" && heldKind === "root") return isUnderRoot(candidate.path, [lock.path]);
  if (candidateKind === "root" && heldKind === "file") return isUnderRoot(lock.path, [candidate.path]);
  if (candidateKind === "root" && heldKind === "root") return rootsOverlap(candidate.path, lock.path);
  return false;
}

function relaxesSameWorkItemRootConflict(jobScope, lock, candidate) {
  // Same-WI parallelism relies on exact file declarations for write isolation;
  // the worktree commit lock still serializes final git integration.
  if (!Array.isArray(jobScope?.files) || jobScope.files.length === 0) return false;
  if (jobScope.workItemId == null || lock?.work_item_id == null) return false;
  if (Number(jobScope.workItemId) !== Number(lock.work_item_id)) return false;
  if (lock.path === "*" || candidate.path === "*") return false;
  return lockKind(lock) === "root" || lockKind(candidate) === "root";
}

export function findFileConflict(jobScope, heldLocks = [], { relaxSameWorkItemRoots = true, allowJobIds = null } = {}) {
  const candidates = scopeToSchedulerLocks(jobScope);
  const allowedJobIds = new Set([
    ...(allowJobIds ? [...allowJobIds] : []),
  ].map((id) => Number(id)));
  for (const lock of heldLocks || []) {
    const sameWorkItem = jobScope?.workItemId != null
      && lock?.work_item_id != null
      && Number(jobScope.workItemId) === Number(lock.work_item_id);
    if (lock?.lock_tier === "work_item" && sameWorkItem) continue;
    if (lock?.lock_tier === "job" && !sameWorkItem && jobScope?.workItemId != null && lock?.work_item_id != null) continue;
    const hit = candidates.find((candidate) => {
      if (
        candidate.job_id != null
        && lock?.job_id != null
        && Number(candidate.job_id) === Number(lock.job_id)
      ) {
        return false;
      }
      if (lock?.job_id != null && allowedJobIds.has(Number(lock.job_id))) {
        return false;
      }
      if (relaxSameWorkItemRoots && relaxesSameWorkItemRootConflict(jobScope, lock, candidate)) {
        return false;
      }
      return schedulerLocksConflict(lock, candidate);
    });
    if (hit) return { lock, candidate: hit };
  }
  return null;
}

export function hasFileConflict(jobScope, lockedFiles, lockedRoots) {
  const lockedRootList = [...lockedRoots];
  if (lockedFiles.size > 0 && jobScope.files.some((f) => lockedFiles.has(f))) return true;
  for (const f of jobScope.files) {
    if (isUnderRoot(f, lockedRootList)) return true;
  }
  for (const root of jobScope.createRoots) {
    if (root === "*" && (lockedFiles.size > 0 || lockedRoots.size > 0)) return true;
    for (const f of lockedFiles) {
      if (isUnderRoot(f, [root])) return true;
    }
    if (lockedRoots.has("*")) return true;
    for (const lockedRoot of lockedRootList) {
      if (rootsOverlap(root, lockedRoot)) return true;
    }
  }
  return false;
}

function strictRootOverlaps(a, b) {
  if (!a || !b || a === "*" || b === "*") return false;
  const aNorm = a.endsWith("/") ? a.slice(0, -1) : a;
  const bNorm = b.endsWith("/") ? b.slice(0, -1) : b;
  if (!aNorm || !bNorm || aNorm === bNorm) return false;
  return rootsOverlap(aNorm, bNorm);
}

export function collectStrictOnlyRootConflicts(jobScope, lockedRoots) {
  if (!Array.isArray(jobScope?.createRoots) || jobScope.createRoots.length === 0) return [];
  if (!lockedRoots || lockedRoots.size === 0) return [];
  const overlaps = [];
  for (const root of jobScope.createRoots) {
    for (const lockedRoot of lockedRoots) {
      if (strictRootOverlaps(root, lockedRoot)) {
        overlaps.push({ root, lockedRoot });
      }
    }
  }
  return overlaps;
}

export function lockConflictNotice(job, conflict) {
  if (!conflict) return null;
  const path = conflict.candidate?.path || conflict.lock?.path || "unknown";
  if (conflict.type === "work_item") {
    const holder = getWorkItem(conflict.lock?.work_item_id);
    const review = holder?.merge_state === "pending_review" ? " pending review" : "";
    return {
      job_id: job.id,
      work_item_id: job.work_item_id,
      path,
      holder_type: "work_item",
      holder_id: conflict.lock?.work_item_id || null,
      holder_status: holder?.status || null,
      holder_merge_state: holder?.merge_state || null,
      message: `#${job.id} waits on ${path}; held by WI#${conflict.lock?.work_item_id}${review}`,
    };
  }
  return {
    job_id: job.id,
    work_item_id: job.work_item_id,
    path,
    holder_type: "job",
    holder_id: conflict.lock?.job_id || null,
    holder_work_item_id: conflict.lock?.work_item_id || null,
    holder_status: conflict.lock?.job_status || null,
    message: `#${job.id} waits on ${path}; held by job #${conflict.lock?.job_id}`,
  };
}
