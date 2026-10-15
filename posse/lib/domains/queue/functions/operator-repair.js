import crypto from "node:crypto";
import { REPAIR_ACTIONS, REPAIR_MAX_RELATED, REPAIR_RECOVERY_KINDS, REPAIR_REJECTIONS } from "../../../catalog/repair.js";
import { questionKindForReviewType } from "../../../catalog/human-input.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getJob, getWorkItem, forceUpdateJobStatus, effectiveMergedEvidence, refreshWorkItemStatus, reholdPostMergeDbTasksForWorkItem, runInTransaction, updateJobPayload } from "./queue-store.js";
import { beginJobRetryGeneration, setAssessmentLifecycle } from "./attempts.js";
import { parseJobPayload } from "./payload.js";
import { rewireDependency } from "./dependencies.js";
import { clearFileLaneWaitsForJob } from "./file-locks.js";
import { clearPeerClaimDeferralsForJob } from "./cross-instance-claims.js";
import { reopenFailedWorkItem, restoreCanceledDependents } from "./work-item-recovery.js";
import { logDurableEvent } from "./events.js";

function snapshot(workItemId, jobId) {
  const db = getDb();
  const job = getJob(jobId);
  const wi = getWorkItem(workItemId);
  if (!job || !wi || job.work_item_id !== workItemId) throw new Error("target_not_found");
  const gates = db.prepare(`SELECT * FROM jobs WHERE work_item_id = ? AND job_type = 'human_input'
    AND status NOT IN ('succeeded','canceled') AND json_valid(payload_json)
    AND CAST(json_extract(payload_json, '$.original_job_id') AS INTEGER) = ? ORDER BY id LIMIT ?`)
    .all(workItemId, jobId, REPAIR_MAX_RELATED + 1);
  const ids = [job.id, ...gates.map(g => g.id)];
  const slots = ids.map(() => "?").join(",");
  const edges = db.prepare(`SELECT d.*, j.work_item_id FROM job_dependencies d JOIN jobs j ON j.id=d.job_id
    WHERE d.job_id = ? OR d.depends_on_job_id IN (${slots}) ORDER BY d.job_id,d.depends_on_job_id LIMIT ?`)
    .all(job.id, ...ids, REPAIR_MAX_RELATED + 1);
  if (gates.length > REPAIR_MAX_RELATED || edges.length > REPAIR_MAX_RELATED) throw new Error("repair_scope_too_large");
  const gateContracts = db.prepare(`SELECT gate_job_id,gate_state,resolution_action FROM human_gates
    WHERE gate_job_id IN (${slots}) ORDER BY gate_job_id`).all(...ids);
  const locks = db.prepare(`SELECT job_id,path,lock_kind,acquired_at FROM job_file_locks
    WHERE job_id=? AND released_at IS NULL ORDER BY path,lock_kind LIMIT ?`).all(jobId,REPAIR_MAX_RELATED+1);
  if (locks.length>REPAIR_MAX_RELATED) throw new Error("repair_scope_too_large");
  const state = crypto.createHash("sha256").update(JSON.stringify({ job, gates, edges, gateContracts, locks, status: wi.status, merge_state: wi.merge_state })).digest("hex");
  return { job, wi, gates, edges, gateContracts, locks, state };
}
function projection(job) {
  return { id: job.id, work_item_id: job.work_item_id, job_type: job.job_type, status: job.status,
    state_version: job.state_version, lease_owner: job.lease_owner, lease_expires_at: job.lease_expires_at,
    assessment_state: job.assessment_state, assessment_last_error: job.assessment_last_error,
    assessor_verdict: job.assessor_verdict, last_error: job.last_error,
    skip_assessment: parseJobPayload(job).skip_assessment === true };
}
export function inspectOperatorRepair(workItemId, jobId) {
  const s = snapshot(workItemId, jobId);
  return { work_item_id: String(workItemId), job_id: String(jobId), expected_state: s.state,
    job: projection(s.job), recovery_gates: s.gates.map(projection), gate_contracts: s.gateContracts, job_locks: s.locks, dependencies: s.edges,
    work_item_status: s.wi.status };
}
function requireIdle(job) {
  // An unknown/malformed expiry is not evidence of an abandoned owner.
  if (job.lease_token && (!Number.isFinite(Date.parse(job.lease_expires_at)) || Date.parse(job.lease_expires_at) >= Date.now())) {
    throw new Error("live_lease");
  }
}

export function applyOperatorRepair(args) {
  const { work_item_id: wi, job_id: id, action, expected_state: expected, reason, enabled } = args;
  if (!Object.values(REPAIR_ACTIONS).includes(action) || typeof reason !== "string" || !reason.trim() || reason.length > 2000
    || !/^[a-f0-9]{64}$/.test(expected || "") || (action === REPAIR_ACTIONS.SET_SKIP_ASSESSMENT && typeof enabled !== "boolean")) {
    return { ok: false, reason: "invalid_repair" };
  }
  try {
    return runInTransaction(() => {
      const s = snapshot(wi, id);
      if (s.state !== expected) throw new Error("stale_repair_state");
      if (["complete", "canceled"].includes(s.wi.status) || s.wi.merge_state === "merge_authorized" || effectiveMergedEvidence(getDb(),s.wi)) throw new Error("work_item_closed");
      if (s.job.job_type === "human_input") throw new Error("use_original_job_or_question");
      requireIdle(s.job);
      const settingOnly = action === REPAIR_ACTIONS.SET_SKIP_ASSESSMENT;
      if (["succeeded", "canceled"].includes(s.job.status)) throw new Error("job_already_terminal");
      if (!settingOnly) {
        for (const gate of s.gates) {
          requireIdle(gate);
          if (s.gateContracts.some(c => c.gate_job_id===gate.id && c.gate_state==="resolving")
            && !(gate.lease_token && Date.parse(gate.lease_expires_at)<Date.now())) throw new Error("gate_resolution_in_progress");
          if (!REPAIR_RECOVERY_KINDS.includes(questionKindForReviewType(parseJobPayload(gate).review_type))) throw new Error("unsupported_related_gate");
        }
        if (s.edges.some(edge => edge.work_item_id !== wi)) throw new Error("cross_work_item_dependents");
      }
      if (action === REPAIR_ACTIONS.WAIVE_ASSESSMENT && ["not_started", null, undefined].includes(s.job.assessment_state) && s.job.job_type !== "assess") throw new Error("implementation_not_complete_use_skip_job");
      const payload = parseJobPayload(s.job);
      if (settingOnly) {
        payload.skip_assessment = enabled;
        updateJobPayload(id, JSON.stringify(payload));
      }
      if (settingOnly) {
        getDb().prepare("UPDATE jobs SET state_version=state_version+1 WHERE id=?").run(id);
      } else {
        if (action === REPAIR_ACTIONS.RETRY_JOB) {
          delete payload._assess_only;
          beginJobRetryGeneration(id, { payload });
          getDb().prepare(`UPDATE jobs SET ready_at=?, assessor_verdict='not_assessed', assessor_confidence=NULL,
            last_error=NULL, result_json=NULL, assessment_completed_at=NULL,
            assessment_max_attempts=MAX(COALESCE(assessment_max_attempts,0),COALESCE(assessment_attempt_count,0)+3) WHERE id=?`)
            .run(new Date().toISOString(),id);
          setAssessmentLifecycle(id, "not_started");
        } else {
          // Keep original verdict/error evidence. Waived is never a passing assessment.
          setAssessmentLifecycle(id, "assessment_waived", { completed: true, error: s.job.assessment_last_error });
        }
        // Reconnect gate dependents to the original job before retiring only its recovery gates.
        for (const gate of s.gates) {
          getDb().prepare("DELETE FROM job_dependencies WHERE job_id=? AND depends_on_job_id=?").run(id, gate.id);
        }
        for (const gate of s.gates) {
          for (const edge of s.edges.filter(e => e.depends_on_job_id === gate.id && e.job_id !== id)) {
            if (!rewireDependency(edge.job_id, gate.id, id, edge.dependency_kind)) throw new Error("dependency_rewire_refused");
          }
          forceUpdateJobStatus(gate.id, "canceled");
        }
        for (const changed of [s.job, ...s.gates]) {
          getDb().prepare("UPDATE job_attempts SET status='interrupted', finished_at=?, error_text=COALESCE(error_text,?) WHERE job_id=? AND status='running'")
            .run(new Date().toISOString(), `Operator repair: ${action}`, changed.id);
          getDb().prepare("UPDATE agent_calls SET status='interrupted', finished_at=?, error_text=COALESCE(error_text,?) WHERE job_id=? AND status='running'")
            .run(new Date().toISOString(), `Operator repair: ${action}`, changed.id);
        }
        forceUpdateJobStatus(id, action === REPAIR_ACTIONS.RETRY_JOB ? "queued" : "succeeded");
        clearFileLaneWaitsForJob(id, "operator_repair");
        clearPeerClaimDeferralsForJob(id);
        if (s.wi.status === "failed") reopenFailedWorkItem(wi, "running", "scoped operator repair");
        if (action !== REPAIR_ACTIONS.RETRY_JOB) {
          logDurableEvent({ work_item_id: wi, job_id: id, event_type: EVENT_TYPES.JOB_REVIEW_SKIPPED,
            actor_type: EVENT_ACTORS.HUMAN, message: `Explicit operator waiver: ${reason.trim()}`,
            event_json: JSON.stringify({ human_resolution: "explicit_waiver", assessor_verdict_preserved: s.job.assessor_verdict,
              assessor_state_version: getJob(id).state_version, execution_waived: action === REPAIR_ACTIONS.SKIP_JOB }) });
        }
        restoreCanceledDependents(wi, [id], { ts: new Date().toISOString(), gateJobId: null, supersededGates: s.gates });
        reholdPostMergeDbTasksForWorkItem(wi);
        refreshWorkItemStatus(wi);
      }
      logDurableEvent({ work_item_id: wi, job_id: id, event_type: EVENT_TYPES.JOB_OPERATOR_REPAIR,
        actor_type: EVENT_ACTORS.HUMAN, message: `Operator repair: ${action}: ${reason.trim()}`,
        event_json: JSON.stringify({ action, reason: reason.trim(), before: projection(s.job), after: projection(getJob(id)),
          recovery_gate_ids: settingOnly ? [] : s.gates.map(g => g.id), explicit_waiver: [REPAIR_ACTIONS.SKIP_JOB, REPAIR_ACTIONS.WAIVE_ASSESSMENT].includes(action) }) });
      return { ...inspectOperatorRepair(wi, id), action, accepted: true };
    });
  } catch (err) {
    if (!REPAIR_REJECTIONS.includes(err.message)) throw err;
    return { ok: false, reason: String(err.message) };
  }
}
