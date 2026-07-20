import {
  getJob,
  getWorkItem,
  listJobsByWorkItem,
  logEvent,
  requeueWorkItemAfterRejection,
  updateWorkItemStatus,
} from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../../queue/functions/reviewable.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import {
  isHumanInputCoordinationPayload,
  isHumanInputReviewPayload,
} from "../../../catalog/human-input.js";

const OPEN_REVIEW_GATE_STATUSES = new Set(["queued", "waiting_on_human", "waiting_on_review"]);

function rejectionDescription(wi, reason) {
  const text = String(reason || "").trim();
  if (!text) return wi.description;
  return `${wi.description}\n\n---\nPREVIOUS ATTEMPT REJECTED: ${text}`;
}

export function isReviewGateJob(job, payload = null) {
  if (!job || job.job_type !== "human_input") return false;
  const parsed = payload || parseJobPayload(job);
  if (parsed?.subtype === "plan_approval") return false;
  if (isHumanInputCoordinationPayload(parsed)) return false;
  if (isHumanInputReviewPayload(parsed)) return true;
  return job.status === "waiting_on_review";
}

export function findPendingReviewGate(wiId, jobs = null) {
  const rows = Array.isArray(jobs) ? jobs : listJobsByWorkItem(wiId);
  for (const job of rows) {
    if (!OPEN_REVIEW_GATE_STATUSES.has(job?.status)) continue;
    const payload = parseJobPayload(job);
    if (isReviewGateJob(job, payload)) return job;
  }
  return null;
}

export function resolveReviewGateJob(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "no_such_job" };
  if (job.job_type !== "human_input") return { ok: false, reason: "not_gate_job" };
  const payload = parseJobPayload(job);
  if (!isReviewGateJob(job, payload)) return { ok: false, reason: "wrong_gate_kind" };
  return { ok: true, job, payload, workItemId: Number(job.work_item_id) || null };
}

function requireReviewableWorkItem(wi) {
  const jobs = listJobsByWorkItem(wi.id);
  const pendingGate = findPendingReviewGate(wi.id, jobs);
  if (pendingGate) return { ok: true, jobs, pendingGate };
  if (wi.status === "waiting_on_review") return { ok: true, jobs, pendingGate: null };
  if (shouldIncludeWorkItemInApprovalQueue(wi, jobs)) return { ok: true, jobs, pendingGate: null };
  return { ok: false, reason: "no_pending_review" };
}

export function approveReview(workItemId, { actor = "bridge" } = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const reviewable = requireReviewableWorkItem(wi);
  if (!reviewable.ok) return reviewable;

  const completionOk = updateWorkItemStatus(wi.id, "complete", {
    allowTerminalFailureBlockers: true,
    resolvePendingReviews: true,
  });
  if (completionOk === false) return { ok: false, reason: "completion_blocked" };

  const fresh = getWorkItem(wi.id) || wi;
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: "Approved via bridge",
    event_json: JSON.stringify({ approval_type: "bridge", merge_required: !!fresh.branch_name }),
  });

  return {
    ok: true,
    work_item_id: wi.id,
    status: fresh.status,
    merge_required: !!fresh.branch_name,
    merge_state: fresh.merge_state,
    branch_name: fresh.branch_name || null,
  };
}

export function rejectReview(workItemId, { actor = "bridge", reason = null, allowBranchWithoutCleanup = false } = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const reviewable = requireReviewableWorkItem(wi);
  if (!reviewable.ok) return reviewable;
  if (wi.branch_name && !allowBranchWithoutCleanup) {
    return {
      ok: false,
      reason: "branch_cleanup_required",
      branch_name: wi.branch_name,
    };
  }

  const updated = requeueWorkItemAfterRejection(wi.id, {
    description: rejectionDescription(wi, reason),
    feedback: reason,
  });
  if (!updated) return { ok: false, reason: "requeue_failed" };

  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_REJECTED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: reason || "Rejected via bridge",
    event_json: JSON.stringify({ approval_type: "bridge" }),
  });

  return {
    ok: true,
    work_item_id: wi.id,
    status: "queued",
  };
}
