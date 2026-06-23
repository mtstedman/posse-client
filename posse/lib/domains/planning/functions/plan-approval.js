// lib/plan-approval.js
//
// Plan-approval gate for the Planner -> Delegator/Dev boundary. Opt-in via
// the 'plan_approval_mode' setting. When enabled,
// the plan compiler creates a human_input gate job, hangs every newly-created
// job off it, and parks the gate at waiting_on_human. An operator then runs
// `posse plan review/approve/reject <wi-id>` to unblock or cancel the cascade.
//
// This module owns the gate creation + state transitions so the plan compiler
// and CLI agree on the semantics. Downstream deps use the standard hard-dep
// mechanism — the scheduler needs no special knowledge.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { TERMINAL_JOB_STATUSES } from "../../queue/functions/common.js";
import {
  addDependency,
  createJob,
  getJob,
  getSetting,
  getWorkItem,
  listJobsByWorkItem,
  logEvent,
  updateJobStatus,
  updateJobPayload,
  updateWorkItemResearchSkip,
} from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  readRunArtifactPayload,
  writeRunArtifactPayload,
} from "../../../shared/telemetry/functions/run-telemetry.js";
import {
  defaultResearchModelTier,
  getResearchBudget,
  isResearchBudgetDeep,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

// Document allowed plan_approval_state values. The DB column is untyped for
// migration simplicity; this set is the authoritative list.
export const PLAN_APPROVAL_STATES = Object.freeze([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);

let _planApprovalOverride = null;

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

/**
 * Is plan-approval gating currently enabled?
 */
export function isPlanApprovalEnabled() {
  if (_planApprovalOverride != null) return _planApprovalOverride === true;
  try {
    return parseBool(getSetting(SETTING_KEYS.PLAN_APPROVAL_MODE));
  } catch {
    return false;
  }
}

export function setPlanApprovalOverrideForRun(value = null) {
  _planApprovalOverride = typeof value === "boolean" ? value : null;
}

function setWorkItemApproval(wiId, state, feedback = null) {
  if (!PLAN_APPROVAL_STATES.includes(state)) {
    throw new Error(`invalid plan_approval_state: ${state}`);
  }
  const db = getDb();
  db.prepare(`
    UPDATE work_items
    SET plan_approval_state = ?, plan_rejection_feedback = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(state, feedback, wiId);
}

function safeJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw_content_json: String(value) };
  }
}

function markRejectedArtificerArtifacts(wiId, gatedJobIds, { feedback = null, gateJobId = null } = {}) {
  const jobs = (gatedJobIds || [])
    .map((id) => getJob(id))
    .filter((job) => job && job.job_type === "artificer" && job.status === "succeeded")
    .map((job) => job.id);
  if (jobs.length === 0) return [];
  const placeholders = jobs.map(() => "?").join(",");
  const db = getDb();
  const rejectedAt = new Date().toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, job_id, attempt_id, artifact_type, storage_kind, file_path, content_json
      FROM artifacts
      WHERE work_item_id = ?
        AND job_id IN (${placeholders})
    `).all(wiId, ...jobs);
    const updateInline = db.prepare(`UPDATE artifacts SET content_json = ? WHERE id = ?`);
    const updateFileBacked = db.prepare(`UPDATE artifacts SET file_path = ?, sha256 = ?, byte_size = ? WHERE id = ?`);
    const marked = [];
    for (const row of rows) {
      const rejectionFlags = {
        plan_rejected: true,
        plan_rejected_at: rejectedAt,
        plan_rejection_gate_job_id: gateJobId,
        plan_rejection_feedback: feedback || null,
      };
      // File-backed artifacts keep content_json NULL in the DB; hydration
      // short-circuits as soon as content_json is set, so writing the flags
      // inline would permanently shadow the payload file. Rewrite the payload
      // with the flags merged instead.
      if (row.storage_kind === "file_path" && row.file_path && row.content_json == null) {
        const payload = readRunArtifactPayload(row.file_path);
        if (payload) {
          try {
            const merged = { ...safeJsonObject(payload.content_json), ...rejectionFlags };
            const stored = writeRunArtifactPayload({
              work_item_id: wiId,
              job_id: row.job_id,
              attempt_id: row.attempt_id ?? null,
              artifact_type: row.artifact_type || "other",
              content_long: payload.content_long,
              content_json: JSON.stringify(merged),
            });
            updateFileBacked.run(stored.file_path, stored.sha256, stored.byte_size, row.id);
            marked.push(row.id);
            continue;
          } catch {
            // Payload rewrite unavailable — skip rather than shadow the content.
            continue;
          }
        }
        // Payload missing or unreadable: nothing to shadow, fall through to inline flags.
      }
      const next = { ...safeJsonObject(row.content_json), ...rejectionFlags };
      updateInline.run(JSON.stringify(next), row.id);
      marked.push(row.id);
    }
    return marked;
  })();
}

function countSucceededPromoteJobs(gatedJobIds) {
  return (gatedJobIds || [])
    .map((id) => getJob(id))
    .filter((job) => job && job.job_type === "promote" && job.status === "succeeded")
    .length;
}

/**
 * Create the approval gate and rewire all newly-created jobs to depend on it.
 * Safe to call even when createdJobIds is empty (returns null without writing).
 *
 * @param {object} planJob - the plan job whose tasks just compiled.
 * @param {number[]} createdJobIds - IDs of jobs the compiler just created.
 * @param {object} [summary] - optional structured summary stored on the gate payload.
 * @returns {number|null} gate job id, or null if no gate was created.
 */
export function createPlanApprovalGate(planJob, createdJobIds, summary = null) {
  if (!planJob || !planJob.work_item_id) return null;
  const targets = (createdJobIds || []).filter((id) => Number.isFinite(Number(id)));
  if (targets.length === 0) return null;

  const wiId = planJob.work_item_id;
  const payload = {
    subtype: "plan_approval",
    plan_job_id: planJob.id,
    gated_job_ids: targets.slice(),
    summary: summary || null,
    created_at: new Date().toISOString(),
  };

  const gate = createJob({
    work_item_id: wiId,
    job_type: "human_input",
    title: `Plan approval: ${(getWorkItem(wiId)?.title || planJob.title || "").slice(0, 60)}`,
    parent_job_id: planJob.id,
    priority: "high",
    model_tier: "cheap",
    reasoning_effort: "low",
    max_attempts: 1,
    payload_json: JSON.stringify(payload),
  });

  for (const targetId of targets) {
    addDependency(targetId, gate.id, "hard");
  }
  // Park the gate at waiting_on_human immediately. The human_input handler
  // never runs (no scheduler lease on a waiting_on_human job), so the gate
  // sits until approve/reject.
  updateJobStatus(gate.id, "waiting_on_human");
  setWorkItemApproval(wiId, "pending", null);

  logEvent({
    work_item_id: wiId,
    job_id: gate.id,
    event_type: EVENT_TYPES.PLAN_APPROVAL_GATE_CREATED,
    actor_type: EVENT_ACTORS.PLANNER,
    message: `Plan approval gate created; ${targets.length} downstream job(s) blocked pending review`,
    event_json: JSON.stringify({ gate_job_id: gate.id, gated_job_ids: targets }),
  });
  return gate.id;
}

/**
 * Find the current pending approval gate for a work item, or null.
 */
export function findPendingGate(wiId) {
  const jobs = listJobsByWorkItem(wiId);
  for (const job of jobs) {
    if (job.job_type !== "human_input") continue;
    if (job.status !== "waiting_on_human") continue;
    const payload = parseJobPayload(job);
    if (payload?.subtype === "plan_approval") return job;
  }
  return null;
}

/**
 * Approve the pending gate on a WI. Transitions the gate job to succeeded so
 * the standard dependency mechanism releases downstream jobs.
 *
 * @returns {object} { ok, gate_job_id } | { ok: false, reason }
 */
export function approvePlan(wiId, { actor = "operator" } = {}) {
  const wi = getWorkItem(wiId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const gate = findPendingGate(wiId);
  if (!gate) return { ok: false, reason: "no_pending_gate" };
  updateJobStatus(gate.id, "succeeded");
  setWorkItemApproval(wiId, "approved", null);
  logEvent({
    work_item_id: wiId,
    job_id: gate.id,
    event_type: EVENT_TYPES.PLAN_APPROVED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: `Plan approved; downstream jobs may proceed`,
  });
  return { ok: true, gateJobId: gate.id };
}

/**
 * Reject the pending gate. Cancels the gate and all its dependents (the whole
 * downstream cascade for this plan). Optionally records feedback on the WI.
 * Does NOT itself spawn a replan — the CLI is responsible for that.
 */
export function rejectPlan(wiId, { feedback = null, actor = "operator" } = {}) {
  const wi = getWorkItem(wiId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const gate = findPendingGate(wiId);
  if (!gate) return { ok: false, reason: "no_pending_gate" };

  // Cancel the gate so dependents see a hard-dep failure (triggers the
  // scheduler's deadlock cancellation). We still also explicitly cancel the
  // created jobs to avoid relying on the deadlock timing.
  updateJobStatus(gate.id, "canceled");

  const payload = parseJobPayload(gate);
  const gated = Array.isArray(payload?.gated_job_ids) ? payload.gated_job_ids : [];
  const rejectedArtifactIds = markRejectedArtificerArtifacts(wiId, gated, { feedback, gateJobId: gate.id });
  const promoteAlreadyRanCount = countSucceededPromoteJobs(gated);
  let canceled = 0;
  for (const targetId of gated) {
    const j = getJob(targetId);
    if (!j) continue;
    if (TERMINAL_JOB_STATUSES.includes(j.status)) continue;
    updateJobStatus(j.id, "canceled");
    canceled += 1;
  }
  // Stash the feedback on the gate payload too so `posse plan review` can
  // show it after rejection.
  try {
    updateJobPayload(gate.id, JSON.stringify({
      ...payload,
      rejection_feedback: feedback,
      rejected_at: new Date().toISOString(),
      rejected_artifact_ids: rejectedArtifactIds,
      promote_already_ran_count: promoteAlreadyRanCount,
    }));
  } catch { /* best effort */ }

  setWorkItemApproval(wiId, "rejected", feedback || null);
  logEvent({
    work_item_id: wiId,
    job_id: gate.id,
    event_type: EVENT_TYPES.PLAN_REJECTED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: `Plan rejected; ${canceled} downstream job(s) canceled${rejectedArtifactIds.length ? `; ${rejectedArtifactIds.length} artifact(s) marked rejected` : ""}${promoteAlreadyRanCount ? `; ${promoteAlreadyRanCount} promote job(s) had already run` : ""}`,
    event_json: JSON.stringify({
      gate_job_id: gate.id,
      canceled_count: canceled,
      feedback: feedback || null,
      rejected_artifact_ids: rejectedArtifactIds,
      promote_already_ran_count: promoteAlreadyRanCount,
    }),
  });
  return { ok: true, gateJobId: gate.id, canceledCount: canceled, rejectedArtifactIds, promoteAlreadyRanCount };
}

/**
 * Spawn a fresh research→plan cycle so the planner can re-decompose with the
 * rejection feedback visible in its payload. Caller-decided — see CLI.
 */
export function respawnAfterRejection(wiId, { feedback = null, rejectedArtifactIds = [] } = {}) {
  const wi = getWorkItem(wiId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  if (wi.research_skipped) {
    updateWorkItemResearchSkip(wiId, { skipped: false, reason: null });
  }
  const researchBudget = getResearchBudget(wi);
  const researchJob = createJob({
    work_item_id: wiId,
    job_type: "research",
    title: `Research (after plan rejection): ${(wi.title || "").slice(0, 60)}`,
    priority: wi.priority || "normal",
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(researchBudget, "medium"),
    payload_json: JSON.stringify({
      deepthink_budget: researchBudget,
      deepthink: isResearchBudgetDeep(researchBudget),
      replan_after_rejection: true,
      previous_rejection_feedback: feedback || null,
      rejected_artifact_ids: Array.isArray(rejectedArtifactIds) ? rejectedArtifactIds : [],
    }),
  });
  // The planner that follows will see the rejection feedback via the WI row's
  // plan_rejection_feedback column (and the research payload we just built).
  logEvent({
    work_item_id: wiId,
    job_id: researchJob.id,
    event_type: EVENT_TYPES.PLAN_REPLAN_SPAWNED,
    actor_type: EVENT_ACTORS.HUMAN,
    message: `Research job spawned for replan after rejection`,
  });
  return { ok: true, researchJobId: researchJob.id };
}

