import { ATLAS_JOIN_MAX_REQUEUES, ATLAS_JOIN_REQUEUE_DELAY_MS } from "../../../../catalog/scheduler-lifecycle.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { ensureWorkItemAtlasJoinAsync, getAtlasIntegrationConfig } from "../../../integrations/functions/atlas.js";
import { completeAttempt, getAttempts, getJob, incrementAndCreateAttempt, isLeaseValid, logEvent, runInTransaction, setJobError } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

export function isAtlasJoinQueueBusy(error) {
  return error?.atlasJoinFailure === true
    && (error.code === "ASYNC_GATE_BUSY" || error.code === "ASYNC_GATE_TIMEOUT");
}

// Do not attach a failed view or latch a transient queue failure onto the job.
// The caller owns deliberate fallback; busy joins must defer provider dispatch.
export async function attachWorktreeAtlas(job, { projectDir, worktreePath, signal = null,
  ensureJoin = ensureWorkItemAtlasJoinAsync } = {}) {
  signal?.throwIfAborted();
  if (job._atlasDisabledForWorkItem) return;
  let joined;
  try {
    joined = await ensureJoin({ projectDir, worktreePath, workItemId: job.work_item_id,
      config: getAtlasIntegrationConfig(), signal });
    signal?.throwIfAborted();
    if (joined.disableAtlas || (joined.attempted && !joined.mounted)) {
      throw Object.assign(new Error(`ATLAS worktree join failed: ${joined.error || joined.skipped || joined.state || "view not mounted"}`), {
        code: joined.errorCode || null,
      });
    }
    job._atlasConfig = joined.config || null;
    job._atlasGraphDbPath = joined.graphDbPath || null;
  } catch (error) {
    // Only queue errors from this boundary belong to Atlas recovery. A Git
    // setup timeout may carry the same shared-gate code and has its own policy.
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.atlasJoinFailure = true;
    throw failure;
  } finally {
    try { joined?.view?.close?.(); } catch { /* best effort */ }
  }
}

// Persist recovery accounting in setup attempts, so a fresh lease/process
// cannot reset the bound. Explicit operator retries start a new generation.
export function deferAtlasJoinAfterQueueBusy(worker, job, leaseToken, error) {
  if (!isAtlasJoinQueueBusy(error)) return false;
  return runInTransaction(() => {
    if (!isLeaseValid(job.id, leaseToken)) return false;
    const generation = Number(parseJobPayload(getJob(job.id))._retry_generation || 0);
    const prior = getAttempts(job.id).filter(entry => {
      if (entry.attempt_number <= generation) return false;
      try { return JSON.parse(entry.notes || "{}").atlas_join_queue_busy === true; } catch { return false; }
    }).length;
    const exhausted = prior >= ATLAS_JOIN_MAX_REQUEUES;
    const attemptId = incrementAndCreateAttempt(job.id, leaseToken, "system", "worktree-setup", null, { setupOnly: true })?.attempt?.id;
    if (!attemptId) return false;
    const message = `${error.message}${exhausted ? `; ATLAS join recovery exhausted after ${prior} requeues` : "; retrying worktree setup before provider dispatch"}`;
    completeAttempt(attemptId, { status: "interrupted", error_text: message,
      notes: JSON.stringify({ atlas_join_queue_busy: true, error_code: error.code }) });
    const readyAt = exhausted ? null : new Date(Date.now() + ATLAS_JOIN_REQUEUE_DELAY_MS).toISOString();
    if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, exhausted ? "failed" : "queued", { attemptId, readyAt })) return false;
    setJobError(job.id, message);
    logEvent({ work_item_id: job.work_item_id, job_id: job.id, attempt_id: attemptId,
      event_type: exhausted ? EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEGRADED : EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEFERRED,
      actor_type: EVENT_ACTORS.ATLAS, message,
      event_json: { source: "worktree_join", reason: "sqlite_gate_busy", code: error.code,
        outcome: exhausted ? "failed" : "deferred",
        requeues: prior, max_requeues: ATLAS_JOIN_MAX_REQUEUES, exhausted, ready_at: readyAt,
        provider_execution_blocked: true } });
    worker.emit(job.id, message);
    return true;
  });
}
