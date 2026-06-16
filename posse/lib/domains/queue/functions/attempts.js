import { getDb } from "../../../shared/storage/functions/index.js";
import { LEASE_HOLDING_STATUSES, now } from "./common.js";
import { leaseNowMs } from "./lease-clock.js";

function leaseNowIso() {
  return new Date(leaseNowMs()).toISOString();
}

/**
 * Check whether a lease token is still valid for a given job.
 * Returns true if the job exists and its lease_token matches.
 */
export function isLeaseValid(jobId, leaseToken) {
  const db = getDb();
  const row = db.prepare(`
    SELECT lease_token, lease_expires_at, status
    FROM jobs
    WHERE id = ?
  `).get(jobId);
  if (row == null) return false;
  if (row.lease_token !== leaseToken) return false;
  if (!LEASE_HOLDING_STATUSES.includes(row.status)) return false;
  if (!row.lease_expires_at) return false;
  return row.lease_expires_at >= leaseNowIso();
}

/**
 * Atomically increment attempt count AND create the attempt record.
 * Validates the lease token first - if the lease was requeued (stale worker),
 * returns null instead of risking a UNIQUE constraint violation.
 */
export function incrementAndCreateAttempt(jobId, leaseToken, workerType, modelName = null, reasoningEffort = null) {
  const db = getDb();
  return db.transaction(() => {
    // Validate lease is still ours before touching attempt data
    const job = db.prepare(`
      SELECT lease_token, lease_expires_at, status, attempt_count
      FROM jobs
      WHERE id = ?
    `).get(jobId);
    if (!job || job.lease_token !== leaseToken) return null;
    if (!LEASE_HOLDING_STATUSES.includes(job.status)) return null;
    if (!job.lease_expires_at || job.lease_expires_at < leaseNowIso()) return null;

    // Derive next attempt number from actual rows, not the counter - the counter
    // can drift when requeueExpiredLeases/decrementAttemptCount undo increments
    // without deleting the attempt row, causing UNIQUE constraint violations.
    const maxRow = db.prepare(`SELECT MAX(attempt_number) AS mx FROM job_attempts WHERE job_id = ?`).get(jobId);
    const newCount = Math.max(job.attempt_count + 1, (maxRow?.mx ?? 0) + 1);
    db.prepare(`UPDATE jobs SET attempt_count = ?, updated_at = ? WHERE id = ?`).run(newCount, now(), jobId);

    const info = db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_number, worker_type, model_name, reasoning_effort)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, newCount, workerType, modelName, reasoningEffort);
    const attempt = db.prepare(`SELECT * FROM job_attempts WHERE id = ?`).get(info.lastInsertRowid);
    return { attemptCount: newCount, attempt };
  })();
}

export function completeAttempt(attemptId, {
  status,
  duration_ms = null,
  prompt_chars = null,
  output_chars = null,
  estimated_input_tokens = null,
  estimated_output_tokens = null,
  prompt_artifact_id = null,
  output_artifact_id = null,
  error_text = null,
  notes = null,
  commit_hash = null,
} = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE job_attempts
    SET status = ?, finished_at = ?, duration_ms = ?,
        prompt_chars = ?, output_chars = ?,
        estimated_input_tokens = ?, estimated_output_tokens = ?,
        prompt_artifact_id = ?, output_artifact_id = ?,
        error_text = ?, notes = ?, commit_hash = COALESCE(?, commit_hash)
    WHERE id = ?
  `).run(
    status, now(), duration_ms,
    prompt_chars, output_chars,
    estimated_input_tokens, estimated_output_tokens,
    prompt_artifact_id, output_artifact_id,
    error_text, notes, commit_hash,
    attemptId,
  );
}

export function setAttemptCommitHash(attemptId, commitHash) {
  const db = getDb();
  db.prepare(`UPDATE job_attempts SET commit_hash = ? WHERE id = ?`).run(commitHash, attemptId);
}

export function setAttemptSession(attemptId, {
  sessionId = null,
  leaseToken = null,
  hopCount = null,
} = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE job_attempts
    SET session_id = ?, session_lease_token = ?, session_hop_count = ?
    WHERE id = ?
  `).run(
    sessionId == null ? null : Number(sessionId),
    leaseToken == null ? null : String(leaseToken),
    hopCount == null ? null : Number(hopCount),
    attemptId,
  );
}

export function getAttempts(jobId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number`).all(jobId);
}

export function getLatestAttempt(jobId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1`).get(jobId);
}
