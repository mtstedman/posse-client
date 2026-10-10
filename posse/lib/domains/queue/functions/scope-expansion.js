import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { parseJobPayload } from "./payload.js";

export const LIVE_SCOPE_WAIT_TIMEOUT_MS = 110_000;
export const LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS = 40_000;
export const LIVE_SCOPE_WAIT_MAX_EXEMPTION_MS = LIVE_SCOPE_WAIT_TIMEOUT_MS + LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS;

export function scopeRequestBatchEntries(request = {}) {
  const batch = Array.isArray(request?.batch)
    ? request.batch.filter((entry) => entry?.path)
    : [];
  if (batch.length > 0) return batch;
  return request?.path
    ? [{
        path: request.path,
        access: request.access,
        operation: request.operation,
        reason: request.reason,
      }]
    : [];
}

export function jobHasLivePendingScopeRequest(job, {
  nowMs = Date.now(),
  maxAgeMs = LIVE_SCOPE_WAIT_MAX_EXEMPTION_MS,
} = {}) {
  if (!job) return false;
  const payload = parseJobPayload(job);
  const pending = payload?._pending_scope_request;
  if (pending?.live_wait !== true || pending.decision || pending.abandoned === true) return false;
  if (maxAgeMs == null) return true;
  const requestedAtMs = Date.parse(String(pending.requested_at || ""));
  if (!Number.isFinite(requestedAtMs)) return false;
  const ageMs = Number(nowMs) - requestedAtMs;
  return ageMs >= -LIVE_SCOPE_WAIT_EXEMPTION_SLACK_MS
    && ageMs <= Math.max(0, Number(maxAgeMs) || 0);
}

export function grantApprovedScopeEntries(result, scopePredicates) {
  if (result?.approved !== true) return 0;
  let granted = 0;
  for (const entry of scopeRequestBatchEntries(result)) {
    if (!entry?.path) continue;
    if (scopePredicates?.policy?.grantWritePath?.(entry.path) !== false) granted += 1;
  }
  return granted;
}

// A queued hard dependent cannot run until this requester succeeds. Borrow
// only an exact, already planned path; roots and soft dependencies provide no
// such proof. Every sibling that owns the path must satisfy the same barrier.
export function dependentSiblingScopeApproval(current, requestedPath, access, jobs, dependencies) {
  if (current.status !== "running" || !["dev", "fix"].includes(current.job_type)) return null;
  const siblings = jobs.filter((job) => job.id !== current.id && job.work_item_id === current.work_item_id);
  const owners = siblings.filter((job) => {
    const payload = parseJobPayload(job);
    const creates = Array.isArray(payload.files_to_create) ? payload.files_to_create : [];
    const modifies = Array.isArray(payload.files_to_modify) ? payload.files_to_modify : [];
    const paths = access === "create" ? creates : [...modifies, ...creates];
    return paths.includes(requestedPath);
  });
  if (!owners.length) return null;
  if (!owners.every((job) => job.status === "queued" && dependencies.some((dep) =>
    dep.job_id === job.id && dep.depends_on_job_id === current.id && dep.dependency_kind === "hard"))) return null;
  // An active sibling with broad or unknown scope might also write this path.
  // Conservatively retain the gate until every sibling writer is idle.
  if (siblings.some((job) => ["leased", "running", "cancel_requested"].includes(job.status)
    && MUTATING_JOB_TYPES.has(job.job_type))) return null;
  return { reason: "dependent_sibling_scope", sibling_job_ids: owners.map((job) => job.id) };
}
