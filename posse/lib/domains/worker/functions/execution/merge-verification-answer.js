// Answers to the merge verification review gate (see
// queue/functions/merge-verification-review.js), from any surface: the
// bridge's review.approve/review.reject and ask, `posse gate answer`, and the
// TUI all resolve the gate through runHumanInputJob.
//
// "pass" needs nothing here: the resolved gate approves the next automatic
// merge. "fail" sends the work item back through the review-rejection requeue
// (its leaf jobs rerun on the kept branch with the operator's feedback as
// rejection guidance), and marks the gate spent so it stops holding the
// reworked work item; the next completion is reviewed with a new gate. The
// kept branch keeps every edit it carries, including cross-WI edits handed
// off from an unmerged upstream, so the requeue keeps the work item's file
// locks and cross-WI merge dependencies: the reworked branch still merges
// only after that upstream, or gets its upstream gate (run 12:50 red team
// round 2, finding 3: clearing them let it merge a failed upstream's edits). A
// fail used to resolve the gate and nothing else: the work item sat complete
// and pending_review, out of automatic merge, with no open gate, while the
// bridge reported success.
//
// The requeue's preconditions are checked before the gate claims a fail, so
// an answer that cannot apply yet (an active job, a merge or shared-trunk
// publication in progress) keeps the gate open with the reason. A work item
// that already left the reviewed state retires the gate as not applicable.
//
// A merge-failure recovery gate (Git refused the merge) answers with the
// same machinery: "merge" merges the work item now, as `posse merge` would,
// and a merge that fails again keeps the gate open with the reason;
// "send_back" is the fail requeue. The approval preflight (dirty worktree,
// unfinished jobs, partial work) still applies; the merge does not settle
// review rows, since that would retire this gate mid-answer
// (operator-merge.js). A recovery gate opened before its own type existed
// answers pass/fail for merge/send_back.

import {
  MERGE_VERIFICATION_REJECTION_KEY,
  appendReviewRejectionDescription,
  getJob,
  getWorkItem,
  hasUnresolvedSharedTrunkMergeOperation,
  isMergeFailureRecoveryPayload,
  logEvent,
  requeueWorkItemAfterRejection,
  reviewRejectionReadiness,
  runInTransaction,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import {
  MERGE_FAILURE_RECOVERY_REVIEW_TYPE,
  MERGE_VERIFICATION_REVIEW_TYPE,
} from "../../../../catalog/human-input.js";
import { preflightReviewApproval } from "../../../bridge/functions/review-decision.js";
import { mergeWorkItemNow } from "../../../git/functions/operator-merge.js";

const MAX_FEEDBACK_CHARS = 2000;

export function isMergeVerificationReviewPayload(payload) {
  return payload?.review_type === MERGE_VERIFICATION_REVIEW_TYPE
    || payload?.review_type === MERGE_FAILURE_RECOVERY_REVIEW_TYPE;
}

// What an answer does: a legacy recovery gate's pass/fail mean merge/send_back,
// and send_back is the review gate's fail.
function effectiveMergeGateAction(payload, action) {
  if (isMergeFailureRecoveryPayload(payload)) {
    if (action === "pass" || action === "merge") return "merge";
    if (action === "fail" || action === "send_back") return "fail";
  }
  return action;
}

/**
 * The operator's feedback: answer metadata (bridge review.reject), or the
 * text after "fail:" (posse gate answer --feedback, a typed TUI answer).
 */
export function mergeVerificationFeedback(answer, metadata = null) {
  const fromMetadata = String(metadata?.operator_feedback ?? metadata?.feedback ?? "").trim();
  if (fromMetadata) return fromMetadata.slice(0, MAX_FEEDBACK_CHARS);
  const match = /^(?:fail|send[ _-]?back)\s*[:\-]\s*([\s\S]+)$/i.exec(String(answer || "").trim());
  return match ? match[1].trim().slice(0, MAX_FEEDBACK_CHARS) : "";
}

function stillUnderReview(workItem) {
  return workItem?.status === "complete" && workItem.merge_state !== "merged";
}

// Why the work item cannot be sent back right now, or null.
function sendBackRefusal(workItem, gateJobId) {
  const id = workItem.id;
  if (workItem.merge_state === "merge_authorized") {
    return `WI#${id} is being merged; answer again once the merge settles`;
  }
  if (hasUnresolvedSharedTrunkMergeOperation(id)) {
    return `WI#${id} has a shared-trunk publication in progress; answer again once it settles`;
  }
  const readiness = reviewRejectionReadiness(id, { ignoreJobIds: [gateJobId] });
  if (!readiness.ok) {
    const active = readiness.activeJob ? `: job #${readiness.activeJob.id} is ${readiness.activeJob.status}` : "";
    return `Cannot send WI#${id} back now (${readiness.reason}${active}); answer again once it settles`;
  }
  return null;
}

/**
 * Checks that must pass before the gate claims the answer. Returns { ok } or
 * { ok: false, message } to keep the gate open.
 */
export function prepareMergeVerificationReviewAnswer(job, payload, action) {
  if (effectiveMergeGateAction(payload, action) !== "fail") return { ok: true };
  const workItem = getWorkItem(Number(job.work_item_id));
  // A stale gate is retired by the claimed answer's own state check.
  if (!stillUnderReview(workItem)) return { ok: true };
  const refusal = sendBackRefusal(workItem, job.id);
  return refusal ? { ok: false, message: refusal } : { ok: true };
}

export function mergeVerificationRejectionGuidance(gateJob, payload = {}, feedback = "") {
  if (isMergeFailureRecoveryPayload(payload)) {
    return [
      `Merge recovery gate #${gateJob.id} sent this change back after its merge into the target branch failed.`,
      payload.context ? `Why the merge failed: ${payload.context}` : null,
      feedback ? `Operator feedback: ${feedback}` : "The operator gave no further feedback.",
      "Rework the branch so it merges cleanly onto the current target branch.",
    ].filter(Boolean).join("\n");
  }
  return [
    `Merge review gate #${gateJob.id} rejected this change before merge.`,
    feedback ? `Operator feedback: ${feedback}` : "The operator gave no further feedback.",
    payload.context ? `Why it was reviewed: ${payload.context}` : null,
    "Before resubmitting, make sure an executed check actually exercises the changed behavior.",
  ].filter(Boolean).join("\n");
}

async function mergeRecoveredWorkItem(workItemId, { actor, projectDir }) {
  const preflight = preflightReviewApproval(workItemId, { projectDir });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, message: preflight.message || preflight.reason };
  return mergeWorkItemNow(workItemId, { projectDir, actor });
}

async function mergeAfterRecovery({ workItemId, actorLabel, projectDir, mergeWorkItem }) {
  const workItem = getWorkItem(workItemId);
  if (workItem?.merge_state === "merged") {
    return { ok: true, merged: true, message: `WI#${workItemId} is already merged` };
  }
  if (!stillUnderReview(workItem)) {
    return {
      ok: false,
      message: `WI#${workItemId} is ${workItem ? workItem.status : "gone"}; the merge recovery no longer applies`,
    };
  }
  let result;
  try {
    result = await mergeWorkItem(workItemId, { actor: String(actorLabel || "operator").toLowerCase(), projectDir });
  } catch (error) {
    result = { ok: false, message: error?.message || String(error) };
  }
  if (result?.ok) {
    const hash = String(result.merge_hash || "").slice(0, 8);
    return { ok: true, merged: true, message: `Merged WI#${workItemId}${hash ? ` at ${hash}` : ""}` };
  }
  // The gate stays the work item's recovery decision: a merge that failed
  // again reopens it with the new reason instead of retiring it.
  return {
    ok: false,
    keepGateOpen: true,
    message: `The merge of WI#${workItemId} failed again: ${result?.message || result?.reason || "unknown error"}`,
  };
}

/**
 * Apply a claimed answer. Returns { ok, message, requeued?, merged? }; ok
 * false retires the gate as not applicable, unless keepGateOpen asks to
 * reopen it for another answer.
 */
export async function applyMergeVerificationReviewAnswer({
  job,
  payload = {},
  action,
  answer = "",
  metadata = null,
  actorType = EVENT_ACTORS.HUMAN,
  actorLabel = "Human",
  projectDir = process.cwd(),
  mergeWorkItem = mergeRecoveredWorkItem,
} = {}) {
  const workItemId = Number(job.work_item_id);
  const effectiveAction = effectiveMergeGateAction(payload, action);
  if (effectiveAction === "merge") {
    return mergeAfterRecovery({ workItemId, actorLabel, projectDir, mergeWorkItem });
  }
  if (effectiveAction === "pass") {
    return { ok: true, message: `WI#${workItemId} may merge: ${actorLabel.toLowerCase()} reviewed the change` };
  }
  if (effectiveAction !== "fail") return { ok: false, message: `Unknown merge review answer ${action}` };
  const workItem = getWorkItem(workItemId);
  if (!stillUnderReview(workItem)) {
    return {
      ok: false,
      message: `WI#${workItemId} is ${workItem ? `${workItem.status}${workItem.merge_state ? `/${workItem.merge_state}` : ""}` : "gone"}; the merge review no longer applies`,
    };
  }
  const refusal = sendBackRefusal(workItem, job.id);
  if (refusal) return { ok: false, message: refusal };

  const feedback = mergeVerificationFeedback(answer, metadata);
  const guidance = mergeVerificationRejectionGuidance(job, payload, feedback);
  const requeued = runInTransaction(() => {
    const ok = requeueWorkItemAfterRejection(workItemId, {
      description: appendReviewRejectionDescription(workItem.description, guidance),
      feedback: guidance,
      preserveJobIds: [job.id],
    });
    if (!ok) return false;
    // Spent: the gate no longer holds the reworked work item.
    updateJobPayload(job.id, JSON.stringify({
      ...parseJobPayload(getJob(job.id) || job),
      [MERGE_VERIFICATION_REJECTION_KEY]: {
        requeued_at: new Date().toISOString(),
        feedback: feedback || null,
      },
    }));
    return true;
  });
  if (!requeued) return { ok: false, message: `WI#${workItemId} could not be sent back (requeue_failed)` };
  logEvent({
    work_item_id: workItemId,
    job_id: job.id,
    event_type: EVENT_TYPES.WORK_ITEM_REJECTED,
    actor_type: actorType,
    message: `${actorLabel} rejected WI#${workItemId} at merge review gate #${job.id}${feedback ? `: ${feedback}` : ""}`,
    event_json: JSON.stringify({
      approval_type: payload.review_type || MERGE_VERIFICATION_REVIEW_TYPE,
      gate_job_id: Number(job.id),
      feedback: feedback || null,
      waived_job_ids: Array.isArray(payload.waived_job_ids) ? payload.waived_job_ids : [],
    }),
  });
  return {
    ok: true,
    requeued: true,
    message: `Sent WI#${workItemId} back for rework${feedback ? " with the operator's feedback" : ""}; its jobs rerun on the branch`,
  };
}
