import { EVENT_ACTORS } from "../../../catalog/event.js";
import { REVIEWED_HANDOFF_OUTCOMES, REVIEWED_HANDOFF_OPERATION_OUTCOMES, REVIEWED_HANDOFF_OPERATION_REASONS } from "../../../catalog/reviewed-handoffs.js";
import { logEvent } from "../../queue/functions/events.js";

const outcomes = new Set(Object.values(REVIEWED_HANDOFF_OUTCOMES));
const operationOutcomes = new Set(REVIEWED_HANDOFF_OPERATION_OUTCOMES);
const reasons = new Set(REVIEWED_HANDOFF_OPERATION_REASONS);

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function elapsed(start, end) {
  if (!timestamp(start) || !timestamp(end)) return null;
  const duration = Date.parse(end) - Date.parse(start);
  // Missing evidence or a clock reversal is unknown, not zero latency.
  return duration >= 0 ? duration : null;
}

function measured(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
}

export function reviewedHandoffReason(value) {
  return value == null ? null : reasons.has(value) ? value : "other";
}

// Explicit fields avoid copying file contents, read-input objects, blocker
// snapshots, and lease authority from the journal into telemetry.
export function reviewedTransferTelemetry(transfer, previous = null) {
  const terminal = ["applied", "canceled"].includes(transfer.state);
  const at = transfer.state === "applied" ? transfer.applied_at : transfer.state === "canceled"
    ? transfer.canceled_at : transfer.updated_at || transfer.reserved_at;
  return {
    schema_version: 1, transfer_id: transfer.transfer_id, receipt_id: transfer.receipt_id,
    source_job_id: transfer.source_job_id, source_work_item_id: transfer.source_work_item_id,
    receiver_job_id: transfer.receiver_job_id, receiver_work_item_id: transfer.receiver_work_item_id,
    state: transfer.state, previous_state: previous?.state || null,
    reason: terminal || transfer.state === "applying" ? null : reviewedHandoffReason(transfer.reason),
    application_outcome: outcomes.has(transfer.application_outcome) ? transfer.application_outcome : null,
    recovered: transfer.recovered === true, integrated: transfer.integrated === true,
    file_count: transfer.files?.length || 0, read_input_count: transfer.read_inputs?.length || 0,
    provenance_count: transfer.required_provenance?.length || 0,
    completed_at: timestamp(transfer.completed_at), reserved_at: timestamp(transfer.reserved_at),
    applying_at: timestamp(transfer.applying_at), applied_at: timestamp(transfer.applied_at),
    canceled_at: timestamp(transfer.canceled_at), sync_commit: transfer.sync_commit || null,
    closeout_to_reservation_ms: elapsed(transfer.completed_at, transfer.reserved_at),
    reservation_elapsed_ms: elapsed(transfer.reserved_at, at),
    applying_elapsed_ms: elapsed(transfer.applying_at, at),
  };
}

// One event per attempted operation, never per scheduler poll. Wall-clock
// journal ages above can include downtime; these durations use a monotonic
// clock and measure only the current operation, including its lock waits.
export function recordReviewedHandoffOperation(job, eventType, detail) {
  try {
    logEvent({ job_id: job.id, work_item_id: job.work_item_id,
      event_type: eventType, actor_type: EVENT_ACTORS.WORKER,
      message: "Reviewed handoff operation finished",
      event_json: JSON.stringify({ schema_version: 1,
        outcome: operationOutcomes.has(detail.outcome) ? detail.outcome : "failed",
        reason: reviewedHandoffReason(detail.reason), duration_ms: measured(detail.duration_ms),
        worktree_lock_wait_ms: measured(detail.worktree_lock_wait_ms),
        branch_lock_wait_ms: measured(detail.branch_lock_wait_ms),
        preparation_ms: measured(detail.preparation_ms), publication_ms: measured(detail.publication_ms),
        transfer_count: measured(detail.transfer_count), dropped_copy_count: measured(detail.dropped_copy_count),
        recovered_count: measured(detail.recovered_count), pending_count: measured(detail.pending_count),
      }) });
  } catch { /* Observability must not change import or refresh behavior. */ }
}
