// Deterministic verification state of a job's committed result, as it stood
// at the job's assessment verdict.
//
// An operator review may override an assessment judgment, but it must not
// relabel a deterministic product failure as passing. The evidence (the
// configured pre-assessment command, then scoped lint/type checks) is written
// as job_observations, which the telemetry tail prunes once the job is
// terminal. So the state is derived from them when the assessment lifecycle
// enters an assessment-only failure state (the job is live or just failed,
// and its observations are retained), and recorded on the job payload bound
// to the commit it describes. Decisions read only that record.

import { getDb } from "../../../shared/storage/functions/index.js";
import { DETERMINISTIC_VERIFICATION_PAYLOAD_KEY, DETERMINISTIC_VERIFICATION_STATES } from "../../../catalog/verification.js";
import { now } from "./common.js";
import { parseJobPayload } from "./payload.js";

const STATES = DETERMINISTIC_VERIFICATION_STATES;
const RECORDED_STATES = new Set([STATES.PASSED, STATES.FAILED, STATES.UNAVAILABLE]);

function latestCommittedAttemptHash(db, jobId) {
  const attempt = db.prepare(`
    SELECT commit_hash FROM job_attempts
    WHERE job_id = ? AND commit_hash IS NOT NULL AND commit_hash != ''
    ORDER BY attempt_number DESC, id DESC LIMIT 1
  `).get(jobId);
  return String(attempt?.commit_hash || "").trim().toLowerCase();
}

// Prefer the configured pre-assessment command; scoped lint/type checks are
// only the fallback when no configured verification result exists for the
// latest committed attempt. Valid only while the job's observations are
// retained, so it is read at the verdict and nowhere else.
function stateFromRetainedObservations(db, jobId, commitHash) {
  const rows = db.prepare(`
    SELECT observation_type, detail_json
    FROM job_observations
    WHERE job_id = ?
      AND observation_type IN ('command.pre_assess', 'assessment.scoped_checks')
    ORDER BY CASE observation_type WHEN 'command.pre_assess' THEN 0 ELSE 1 END, id DESC
  `).all(jobId);
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
    const result = row.observation_type === "assessment.scoped_checks"
      ? detail?.scoped_check_result || detail
      : detail;
    const resultCommit = String(
      result?.assessed_commit_hash || result?.executed_commit_hash || result?.commit_hash || "",
    ).trim().toLowerCase();
    if (commitHash && resultCommit !== commitHash) continue;
    const source = row.observation_type;
    const outcome = result?.verification_outcome || detail?.verification_outcome || {};
    if (outcome.type === "product_failed") return { state: STATES.FAILED, source };
    if (outcome.type === "passed") return { state: STATES.PASSED, source };
    if (outcome.type) return { state: STATES.UNAVAILABLE, source };
    if (result?.status === "failed") return { state: STATES.FAILED, source };
    if (result?.status === "passed") return { state: STATES.PASSED, source };
    return { state: STATES.UNAVAILABLE, source };
  }
  return { state: STATES.UNAVAILABLE, source: null };
}

/** Record the job's deterministic verification state at its assessment verdict. */
export function recordDeterministicVerificationAtVerdict(jobId) {
  const db = getDb();
  const commitHash = latestCommittedAttemptHash(db, jobId);
  const { state, source } = stateFromRetainedObservations(db, jobId, commitHash);
  const record = JSON.stringify({ state, source, commit_hash: commitHash || null, recorded_at: now() });
  const path = `$.${DETERMINISTIC_VERIFICATION_PAYLOAD_KEY}`;
  db.prepare(`
    UPDATE jobs
    SET payload_json = CASE
      WHEN payload_json IS NULL OR trim(payload_json) = '' THEN json_set('{}', ?, json(?))
      WHEN json_valid(payload_json) THEN json_set(payload_json, ?, json(?))
      ELSE json_set(json_object('_legacy_invalid_payload_json', payload_json), ?, json(?))
    END
    WHERE id = ?
  `).run(path, record, path, record, path, record, jobId);
  return state;
}

/**
 * The state recorded at the job's verdict for its latest committed attempt.
 * UNKNOWN when nothing was recorded (a job that failed before the state was
 * recorded) or the record describes an earlier commit; callers fail closed.
 */
export function latestDeterministicVerificationState(jobId) {
  const db = getDb();
  const record = parseJobPayload(db.prepare(`SELECT payload_json FROM jobs WHERE id = ?`).get(jobId))[DETERMINISTIC_VERIFICATION_PAYLOAD_KEY];
  if (!record || !RECORDED_STATES.has(record.state)) return STATES.UNKNOWN;
  const recordedCommit = String(record.commit_hash || "").trim().toLowerCase();
  return recordedCommit === latestCommittedAttemptHash(db, jobId) ? record.state : STATES.UNKNOWN;
}
