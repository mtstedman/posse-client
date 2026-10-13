import { gitExecAsync } from "../../../git/functions/utils.js";
import { getJob, isLeaseValid, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

function porcelainPaths(raw = "") {
  const fields = String(raw || "").split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3).replace(/\\/g, "/").trim();
    if (filePath) paths.push(filePath);
    // Porcelain v1 -z emits the original path as a second field for renames
    // and copies. It has no status prefix and is diagnostic-only here.
    if ((status.includes("R") || status.includes("C")) && index + 1 < fields.length) {
      index += 1;
    }
  }
  return [...new Set(paths)];
}

/**
 * Assessment reads and deterministic checks must observe a committed tree.
 * Return a normal readiness result for transient dirt so callers can defer
 * before consuming assessment retries instead of surfacing an infra error.
 */
export async function inspectAssessmentWorktreeReadiness(cwd, { signal = null } = {}) {
  if (!cwd) return { ready: true, dirty_count: 0, dirty_paths: [], porcelain: "" };
  const porcelain = String(await gitExecAsync(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    { trim: false, signal },
  ) || "");
  const dirtyPaths = porcelainPaths(porcelain);
  return {
    ready: porcelain.length === 0,
    dirty_count: dirtyPaths.length,
    dirty_paths: dirtyPaths,
    porcelain,
  };
}

export function assessmentWorktreeDirtySummary(readiness = {}, limit = 5) {
  const paths = Array.isArray(readiness?.dirty_paths) ? readiness.dirty_paths.filter(Boolean) : [];
  if (paths.length === 0) return "uncommitted worktree changes";
  const preview = paths.slice(0, limit).join(", ");
  return `${paths.length} uncommitted path(s): ${preview}${paths.length > limit ? " ..." : ""}`;
}

/** Bound readiness deferrals separately from paid assessment attempts. */
export function recordAssessmentWorktreeReadiness(job, leaseToken, readiness, implementationAttemptId) {
  // Inspection awaits git; cancellation or a new lease can win during it.
  if (!isLeaseValid(job.id, leaseToken)) return { leaseLost: true, recoveryError: null };
  const fresh = getJob(job.id) || job;
  const payload = parseJobPayload(fresh);
  const previous = payload._assessment_worktree_deferral;
  if (readiness.ready) {
    if (previous) {
      delete payload._assessment_worktree_deferral;
      job.payload_json = JSON.stringify(payload);
      updateJobPayload(job.id, job.payload_json);
    }
    return { leaseLost: false, recoveryError: null };
  }

  // Durable state survives worker restarts and telemetry pruning. A new
  // implementation or a clean inspection starts a fresh deferral budget.
  const count = (previous?.implementation_attempt_id === implementationAttemptId
    ? Math.max(0, Number(previous.count) || 0)
    : 0) + 1;
  const limit = Math.max(1, Number(fresh.assessment_max_attempts || 3));
  payload._assessment_worktree_deferral = { implementation_attempt_id: implementationAttemptId, count };
  job.payload_json = JSON.stringify(payload);
  updateJobPayload(job.id, job.payload_json);
  if (count < limit) return { leaseLost: false, recoveryError: null };

  const recoveryError = new Error(`Assessment worktree remained dirty after ${count}/${limit} readiness checks: ${assessmentWorktreeDirtySummary(readiness)}. Preserve or commit these changes, then retry assessment.`);
  recoveryError.assessmentGateImmediately = true;
  return { leaseLost: false, recoveryError };
}
