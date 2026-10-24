import { parseJobPayload } from "./payload.js";
import { getLatestAttempt } from "./attempts.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";

// A job blocked inside an environment setup tool call is waiting on the user
// or on approved installers, not making provider progress. The marker carries
// its own deadline and attempt, so a marker left behind by a crashed call
// expires and never exempts a later attempt.
export function jobHasLiveEnvironmentSetup(job, { nowMs = Date.now() } = {}) {
  if (!job) return false;
  const live = parseJobPayload(job)?._environment_setup_live;
  const deadlineMs = Date.parse(String(live?.deadline_at || ""));
  if (!Number.isFinite(deadlineMs) || Number(nowMs) > deadlineMs) return false;
  const attempt = getLatestAttempt(job.id);
  return attempt?.status === "running" && Number(attempt.id) === Number(live.attempt_id);
}

/**
 * Compute parking for a job inside a live setup call. Such a job holds no
 * model compute, so the scheduler frees its agent slot ("parked"). Before the
 * tool call returns, the call asks to resume and the scheduler grants one
 * resume per free slot, so concurrency is restored instead of exceeded. Null
 * when the job is not inside a live setup call.
 *
 * @returns {{ approval_job_id: number, resume_requested: boolean, resume_granted: boolean } | null}
 */
export function environmentSetupParking(job, { nowMs = Date.now() } = {}) {
  if (!jobHasLiveEnvironmentSetup(job, { nowMs })) return null;
  const live = parseJobPayload(job)._environment_setup_live;
  return {
    approval_job_id: Number(live.approval_job_id),
    resume_requested: !!live.resume_requested_at,
    resume_granted: !!live.resume_granted_at,
  };
}

// The marker belongs to one approval; a later call's marker is never patched
// by a stale request or grant. The payload is rewritten in one immediate
// transaction because the MCP process and the scheduler both patch it.
function patchLiveEnvironmentSetup(jobId, approvalJobId, patch) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = db.prepare("SELECT id, payload_json FROM jobs WHERE id = ?").get(jobId);
    const payload = row ? parseJobPayload(row) : null;
    const live = payload?._environment_setup_live;
    if (!live || Number(live.approval_job_id) !== Number(approvalJobId)) return false;
    db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...payload, _environment_setup_live: { ...live, ...patch } }), now(), jobId);
    return true;
  });
}

export function requestEnvironmentSetupResume(jobId, approvalJobId) {
  return patchLiveEnvironmentSetup(jobId, approvalJobId, { resume_requested_at: new Date().toISOString() });
}

export function grantEnvironmentSetupResume(jobId, approvalJobId) {
  return patchLiveEnvironmentSetup(jobId, approvalJobId, { resume_granted_at: new Date().toISOString() });
}

export function environmentSetupResumeGranted(job, approvalJobId) {
  const live = parseJobPayload(job)?._environment_setup_live;
  return !!live && Number(live.approval_job_id) === Number(approvalJobId) && !!live.resume_granted_at;
}
