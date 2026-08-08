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
    const attemptNumber = (maxRow?.mx ?? 0) + 1;
    const newCount = job.attempt_count + 1;
    db.prepare(`
      UPDATE jobs
      SET attempt_count = ?, state_version = state_version + 1, updated_at = ?
      WHERE id = ?
    `).run(newCount, now(), jobId);

    const info = db.prepare(`
      INSERT INTO job_attempts (
        job_id, attempt_number, attempt_kind, worker_type, model_name, reasoning_effort
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      attemptNumber,
      workerType === "human" ? "human" : "implementation",
      workerType,
      modelName,
      reasoningEffort,
    );
    const attempt = db.prepare(`SELECT * FROM job_attempts WHERE id = ?`).get(info.lastInsertRowid);
    return { attemptCount: newCount, attempt };
  })();
}

/**
 * Create an assessor-only attempt without consuming the implementation retry
 * budget. The display attempt_number remains a monotonically increasing row
 * sequence while assessment_attempt_count is the independent retry budget.
 */
export function incrementAndCreateAssessmentAttempt(
  jobId,
  leaseToken,
  modelName = null,
  reasoningEffort = null,
) {
  const db = getDb();
  return db.transaction(() => {
    const job = db.prepare(`
      SELECT lease_token, lease_expires_at, status, assessment_attempt_count
      FROM jobs
      WHERE id = ?
    `).get(jobId);
    if (!job || job.lease_token !== leaseToken) return null;
    if (!LEASE_HOLDING_STATUSES.includes(job.status)) return null;
    if (!job.lease_expires_at || job.lease_expires_at < leaseNowIso()) return null;

    const maxRow = db.prepare(
      `SELECT MAX(attempt_number) AS mx FROM job_attempts WHERE job_id = ?`
    ).get(jobId);
    const attemptNumber = (maxRow?.mx ?? 0) + 1;
    const assessmentCount = Number(job.assessment_attempt_count || 0) + 1;
    db.prepare(`
      UPDATE jobs
      SET assessment_attempt_count = ?,
          assessment_state = 'assessment_pending',
          assessment_last_error = NULL,
          state_version = state_version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(assessmentCount, now(), jobId);
    const info = db.prepare(`
      INSERT INTO job_attempts (
        job_id, attempt_number, attempt_kind, worker_type, model_name, reasoning_effort
      ) VALUES (?, ?, 'assessment', 'assessor', ?, ?)
    `).run(jobId, attemptNumber, modelName, reasoningEffort);
    const attempt = db.prepare(`SELECT * FROM job_attempts WHERE id = ?`).get(info.lastInsertRowid);
    return { attemptCount: assessmentCount, assessmentAttemptCount: assessmentCount, attempt };
  })();
}

/**
 * Count an assessment attached to the implementation attempt that just
 * completed. No new attempt row is created.
 */
export function beginAttachedAssessmentAttempt(jobId, leaseToken) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE jobs
    SET assessment_attempt_count = assessment_attempt_count + 1,
        assessment_state = 'assessment_pending',
        assessment_last_error = NULL,
        state_version = state_version + 1,
        updated_at = ?
    WHERE id = ?
      AND lease_token = ?
      AND status IN (${LEASE_HOLDING_STATUSES.map(() => "?").join(",")})
  `).run(now(), jobId, leaseToken, ...LEASE_HOLDING_STATUSES);
  if (result.changes !== 1) return null;
  return db.prepare(`
    SELECT assessment_attempt_count, assessment_max_attempts, assessment_state
    FROM jobs WHERE id = ?
  `).get(jobId);
}

export function setAssessmentLifecycle(jobId, state, {
  error = null,
  completed = false,
} = {}) {
  const allowed = new Set([
    "not_started",
    "implementation_complete",
    "assessment_pending",
    "assessment_passed",
    "assessment_failed",
    "assessment_needs_human",
    "assessment_unavailable",
    "assessment_waived",
  ]);
  if (!allowed.has(state)) throw new Error(`Invalid assessment lifecycle state: ${state}`);
  const db = getDb();
  const result = db.prepare(`
    UPDATE jobs
    SET assessment_state = ?,
        assessment_last_error = ?,
        assessment_completed_at = CASE WHEN ? THEN ? ELSE assessment_completed_at END,
        state_version = state_version + 1,
        updated_at = ?
    WHERE id = ?
  `).run(
    state,
    error == null ? null : String(error).slice(0, 4000),
    completed ? 1 : 0,
    now(),
    now(),
    jobId,
  );
  return result.changes === 1;
}

export function extendAssessmentMaxAttempts(jobId, minMaxAttempts) {
  const target = Math.max(1, Math.floor(Number(minMaxAttempts) || 0));
  const result = getDb().prepare(`
    UPDATE jobs
    SET assessment_max_attempts = MAX(COALESCE(assessment_max_attempts, 0), ?),
        updated_at = ?
    WHERE id = ?
  `).run(target, now(), jobId);
  return result.changes === 1;
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

export function setAttemptModelName(attemptId, modelName) {
  const db = getDb();
  db.prepare(`UPDATE job_attempts SET model_name = ? WHERE id = ?`).run(modelName, attemptId);
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

/**
 * True when the job has at least one implementation attempt row. Use this —
 * not jobs.attempt_count — to decide whether work ever executed: the counter
 * is decremented when a job parks for scope approval, so it can read 0 after
 * real execution, while attempt rows are never deleted.
 */
export function hasImplementationAttempts(jobId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM job_attempts WHERE job_id = ? AND attempt_kind = 'implementation' LIMIT 1`
  ).get(jobId);
  return row != null;
}

export function getLatestAttempt(jobId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1`).get(jobId);
}
