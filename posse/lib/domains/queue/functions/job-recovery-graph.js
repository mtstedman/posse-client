import { parseJobPayload } from "./payload.js";

// Recovery work may be parented under a plan or coordination gate instead of
// the implementation it replaces. Both completion and partial-work projections
// follow these links; their inclusion/terminal policies remain view-specific.
export function buildJobRecoveryGraph(jobs = []) {
  const byOriginal = new Map();
  for (const job of jobs) {
    if (!job) continue;
    const payload = parseJobPayload(job);
    const originalIds = new Set([
      job.parent_job_id,
      payload._dead_letter_recovery?.original_job_id,
      payload._promote_followup_of,
      payload._partial_deliverable_repair_for,
      payload._promote_missing_repair_for,
    ].map(Number));
    for (const id of originalIds) {
      if (!Number.isSafeInteger(id) || id <= 0 || id === Number(job.id)) continue;
      if (!byOriginal.has(id)) byOriginal.set(id, []);
      byOriginal.get(id).push(job);
    }
  }
  return byOriginal;
}

export function hasSucceededRecoveryDescendant(jobId, byOriginal) {
  const stack = [...(byOriginal.get(Number(jobId)) || [])];
  const seen = new Set([Number(jobId)]);
  while (stack.length > 0) {
    const current = stack.pop();
    const id = Number(current?.id);
    if (!current || seen.has(id)) continue;
    seen.add(id);
    if (current.status === "succeeded" && current.job_type !== "human_input") return true;
    stack.push(...(byOriginal.get(id) || []));
  }
  return false;
}
