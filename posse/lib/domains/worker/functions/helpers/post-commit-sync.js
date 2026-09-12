import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { completeAttempt, logEvent, refreshWorkItemStatus, releaseLease, runInTransaction, setAttemptCommitHash, setJobError } from "../../../queue/functions/index.js";
import { completePendingCrossWiFileSyncsAsync } from "./worktree-lifecycle.js";

// Sync is a separate failure boundary: Git may already have committed useful
// work. Fail closed with that identity and leave the branch available for repair.
export async function finishPostCommitSync(worker, { job, attempt, leaseToken, wtPath,
  commitHash = null, baseHash = null, startTime = Date.now() }, {
  synchronize = completePendingCrossWiFileSyncsAsync,
} = {}) {
  if (commitHash) setAttemptCommitHash(attempt.id, commitHash, baseHash);
  try {
    return { ok: true, sync: await synchronize(worker, job, wtPath) };
  } catch (error) {
    const message = `Cross-WI synchronization failed${commitHash ? ` after commit ${commitHash}` : ""}: ${error?.message || error}`;
    runInTransaction(() => {
      completeAttempt(attempt.id, { status: "failed", duration_ms: Date.now() - startTime, error_text: message });
      if (releaseLease(job.id, leaseToken, "failed")) {
        setJobError(job.id, message);
        refreshWorkItemStatus(job.work_item_id);
      }
    });
    logEvent({ work_item_id: job.work_item_id, job_id: job.id, attempt_id: attempt.id,
      event_type: EVENT_TYPES.JOB_ATTEMPT_FAILED, actor_type: EVENT_ACTORS.WORKER,
      message, event_json: { phase: "cross_wi_sync", commit_hash: commitHash } });
    worker.emit(job.id, message);
    return { ok: false, error };
  }
}
