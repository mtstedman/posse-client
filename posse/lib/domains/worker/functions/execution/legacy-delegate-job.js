// legacy-delegate-job.js — close a `delegate` job left in an older database.
//
// Provider assignment now happens deterministically when the plan compiles, so
// no new `delegate` jobs are created and the ML delegator role is gone. A
// queued row from before that change still gates its dependents, so run the
// same deterministic assignment for its pending jobs and succeed without a
// provider call. Jobs it cannot assign keep rotating providers at execution.

import { C } from "../../../../shared/format/functions/colors.js";
import {
  applyDelegation,
  completeAttempt,
  getJob,
  incrementAndCreateAttempt,
  refreshWorkItemStatus,
  setJobResult,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { getProviderMap } from "../../../providers/functions/provider.js";
import { buildDeterministicDelegations } from "../../../providers/functions/delegation-routing.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";

export async function runLegacyDelegateJob(worker, job, wrappedJob, {
  leaseToken = null,
  deps = {},
} = {}) {
  const {
    buildAssignments = buildDeterministicDelegations,
    apply = applyDelegation,
    readJob = getJob,
    providerMap = null,
  } = deps;
  const startedAt = Date.now();
  let attempt = null;
  try {
    attempt = incrementAndCreateAttempt(job.id, leaseToken, "system", "legacy-delegate", null);
    if (!attempt) {
      logAttemptSkippedStaleLease(job, "system", "Skipped legacy delegate attempt because the lease was stale or expired");
      return;
    }

    const payload = parseJobPayload(job) || {};
    const pendingJobs = (Array.isArray(payload.pending_jobs) ? payload.pending_jobs : [])
      .filter((pending) => readJob(pending?.job_id)?.work_item_id === job.work_item_id);
    const assignments = buildAssignments(pendingJobs, {
      providerMap: providerMap || payload.provider_map || getProviderMap(),
      getJobById: readJob,
    }) || [];
    for (const assignment of assignments) {
      apply(assignment.job_id, {
        provider: assignment.provider || null,
        model: assignment.model || null,
        model_tier: assignment.model_tier || null,
        reasoning_effort: assignment.reasoning_effort || null,
        priority: assignment.priority || null,
      });
    }

    const result = { legacy_delegate: true, assigned: assignments.length, pending: pendingJobs.length };
    setJobResult(job.id, result);
    completeAttempt(attempt.attempt.id, {
      status: "succeeded",
      duration_ms: Date.now() - startedAt,
      output_chars: 0,
    });
    if (worker._releaseLease(job, leaseToken, "succeeded") && job.work_item_id) {
      refreshWorkItemStatus(job.work_item_id);
    }
    worker.emit(job.id, `${C.magenta}[delegation]${C.reset} WI#${job.work_item_id} legacy delegate job #${job.id}: assigned ${assignments.length} of ${pendingJobs.length} job(s) deterministically`);
  } catch (error) {
    const message = error?.message || String(error);
    if (attempt) {
      completeAttempt(attempt.attempt.id, {
        status: "failed",
        duration_ms: Date.now() - startedAt,
        error_text: message,
      });
    }
    try { await wrappedJob?.setError?.(message); } catch { /* best effort */ }
    if (worker._releaseLease(job, leaseToken, "failed") && job.work_item_id) {
      refreshWorkItemStatus(job.work_item_id);
    }
    worker.emit(job.id, `${C.yellow}[delegation] WI#${job.work_item_id} legacy delegate job #${job.id} failed: ${message}${C.reset}`);
  }
}
