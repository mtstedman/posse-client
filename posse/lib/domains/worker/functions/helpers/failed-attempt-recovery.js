import { FINAL_REVIEW_OBSERVATIONS } from "../../../../catalog/final-review.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { getAttempts, getJob, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

// Preserve a recovery pointer, not permission to restore a patch. The next
// attempt may have a different HEAD, scope, or set of active siblings.
export function linkFailedAttemptSnapshot(job, snapshot) {
  if (!snapshot) return;
  const payload = parseJobPayload(getJob(job.id) || job);
  const attempts = getAttempts(job.id);
  const attempt = attempts.at(-1);
  const review = getDb().prepare(`SELECT detail_json FROM job_observations
    WHERE job_id = ? AND observation_type = ? AND attempt_id = ? ORDER BY id DESC LIMIT 1`)
    .get(job.id, FINAL_REVIEW_OBSERVATIONS.RESULT, attempt?.id ?? null);
  let feedback = null;
  try { feedback = JSON.parse(review?.detail_json || "null"); } catch { /* no usable feedback */ }
  updateJobPayload(job.id, JSON.stringify({ ...payload, _failed_attempt_recovery: {
    snapshot_ref: String(snapshot),
    snapshot_commit: snapshot.objectHash || null,
    attempt_id: attempt?.id ?? null,
    paths: [...new Set(["files_to_modify", "files_to_create", "files_to_delete"]
      .flatMap(key => Array.isArray(payload[key]) ? payload[key] : []))],
    review: feedback ? { outcome: feedback.outcome, summary: String(feedback.summary || feedback.reason || "").slice(0, 2000),
      findings: (Array.isArray(feedback.findings) ? feedback.findings : []).slice(0, 10) } : null,
  } }));
}

export function renderFailedAttemptRecovery(payload = {}) {
  const saved = payload._failed_attempt_recovery;
  if (!saved?.snapshot_ref) return null;
  return [
    "PRESERVED FAILED ATTEMPT:",
    `Attempt ${saved.attempt_id ?? "unknown"}: ${saved.snapshot_ref}`,
    `Prior declared scope: ${(saved.paths || []).join(", ")}`,
    "The snapshot is recovery evidence, not verified current work. Compare it with current HEAD and current scope before reusing any part. Do not reset the worktree or overwrite sibling changes to restore it.",
    saved.review ? `Last review of that attempt: ${JSON.stringify(saved.review).slice(0, 6000)}` : null,
  ].filter(Boolean).join("\n");
}
