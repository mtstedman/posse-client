import { displayRoleForJobType } from "../../providers/functions/roles.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { createRunWrapUpTracker } from "../functions/review-session.js";
import { BACKGROUND_JOB_TYPES } from "../../../catalog/job.js";
import { logAgentActivity } from "../../queue/functions/events.js";

function terminalActivityStatus(status) {
  if (status === "succeeded") return { kind: "result", status: "succeeded" };
  if (status === "canceled") return { kind: "result", status: "canceled" };
  if (status === "failed" || status === "dead_letter") return { kind: "error", status: "failed" };
  return { kind: "phase", status: "waiting" };
}

function activitySummaryForJob(job) {
  return String(job?.title || job?.job_type || "Job")
    .replace(/^(Research|Plan|Ask|Fix|Assess|Dev):\s*/i, "")
    .slice(0, 180);
}

export class RunSchedulerLoopCallbacks {
  constructor({
    getDisplay = () => null,
    C,
    worker,
    getJob,
    idleAutoMerge,
    hasAutoMergeableCompletedWorkItems = null,
    autoMergePendingReviewBlockers = false,
    describePendingReviewLockBlockers = () => null,
  } = {}) {
    this.getDisplay = getDisplay;
    this.C = C;
    this.worker = worker;
    this.getJob = getJob;
    this.idleAutoMerge = idleAutoMerge;
    this.hasAutoMergeableCompletedWorkItems = hasAutoMergeableCompletedWorkItems;
    this.autoMergePendingReviewBlockers = autoMergePendingReviewBlockers;
    this.describePendingReviewLockBlockers = describePendingReviewLockBlockers;
    this.lastPendingReviewBlockerMsg = null;
    this.pendingReviewAutoMergeAttempts = new Set();
    this.backgroundWrapUp = null;
  }

  callbacks() {
    return {
      onJobStart: (job) => this.onJobStart(job),
      onJobEnd: (job) => this.onJobEnd(job),
      onIdle: (activeJobs) => this.onIdle(activeJobs),
      onDone: () => this.onDone(),
      onBackgroundOnly: (state) => this.onBackgroundOnly(state),
      onSlotStatus: (status) => this.onSlotStatus(status),
      onKillJob: (jobId, reason) => this.worker.killJob(jobId, reason),
    };
  }

  onJobStart(job) {
    // Background maintenance (atlas_warm) is not agent work — keep it out of the
    // Workers list and the monitor fleet. It runs on its own scheduler budget and
    // remains visible in the queue job list and the ATLAS readiness bars.
    if (BACKGROUND_JOB_TYPES.has(job.job_type)) return;
    const role = displayRoleForJobType(job.job_type);
    const titleClean = activitySummaryForJob(job);
    logAgentActivity({
      work_item_id: job.work_item_id,
      job_id: job.id,
      role,
      actor_id: String(job.id),
      kind: "phase",
      status: "running",
      phase: job.job_type,
      summary: titleClean,
      provider: job.provider || null,
      model: job.model_name || job.model_tier || null,
    });

    const display = this.getDisplay();
    if (!display) return;
    display.setWorker(job.id, {
      role,
      activity: titleClean,
      tier: job.model_tier || "standard",
      effort: job.reasoning_effort || "medium",
      attempt: (job.attempt_count || 0) + 1,
      workItemId: job.work_item_id,
      provider: job.provider || null,
      modelName: job.model_name || null,
      emitStart: false,
    });
  }

  onJobEnd(job) {
    const display = this.getDisplay();
    const freshJob = this.getJob(job.id) || job;
    if (display) {
      display.removeWorker(job.id, freshJob?.status || "done");
    }
    if (!BACKGROUND_JOB_TYPES.has(freshJob.job_type)) {
      const role = displayRoleForJobType(freshJob.job_type);
      const activity = terminalActivityStatus(freshJob.status);
      logAgentActivity({
        work_item_id: freshJob.work_item_id,
        job_id: freshJob.id,
        role,
        actor_id: String(freshJob.id),
        kind: activity.kind,
        status: activity.status,
        phase: freshJob.job_type,
        summary: activitySummaryForJob(freshJob),
        provider: freshJob.provider || null,
        model: freshJob.model_name || freshJob.model_tier || null,
      });
    }
    if (freshJob?.status !== "succeeded") return;
    let hasMergeable = false;
    try {
      hasMergeable = typeof this.hasAutoMergeableCompletedWorkItems === "function"
        && this.hasAutoMergeableCompletedWorkItems();
    } catch {
      hasMergeable = false;
    }
    if (!hasMergeable) return;
    this.idleAutoMerge.start({
      reason: "job completion",
      runGc: false,
      afterMerged: (mergedCount) => {
        const mergedMsg = `Auto-merged ${mergedCount} completed work item${mergedCount === 1 ? "" : "s"} after job completion.`;
        if (display) display.addEvent(`${this.C.green}${mergedMsg}${this.C.reset}`);
        else console.log(`\n  ${this.C.green}${mergedMsg}${this.C.reset}`);
      },
      onError: (err) => {
        const errMsg = `Auto-merge after job completion failed: ${err?.message || err}`;
        if (display) display.addEvent(`${this.C.red}${errMsg}${this.C.reset}`);
        else console.log(`\n  ${this.C.red}${errMsg}${this.C.reset}`);
      },
    });
  }

  onIdle(activeJobs) {
    const display = this.getDisplay();
    const pendingReviewBlocker = this.describePendingReviewLockBlockers();
    if (pendingReviewBlocker && pendingReviewBlocker !== this.lastPendingReviewBlockerMsg) {
      this.lastPendingReviewBlockerMsg = pendingReviewBlocker;
      if (this.autoMergePendingReviewBlockers && this.idleAutoMerge.autoMergeCompletedWorkItems) {
        if (!this.idleAutoMerge.isRunning() && !this.pendingReviewAutoMergeAttempts.has(pendingReviewBlocker)) {
          this.pendingReviewAutoMergeAttempts.add(pendingReviewBlocker);
          this.idleAutoMerge.start({
            reason: "pending-review blocker",
            runGc: false,
            beforeStart: () => {
              const msg = "Queued work is blocked by pending review; auto-merge is enabled, attempting merge.";
              if (display) display.addEvent(`${this.C.cyan}${msg}${this.C.reset}`);
              else console.log(`\n  ${this.C.cyan}${msg}${this.C.reset}`);
            },
            afterMerged: (mergedCount) => {
              if (mergedCount > 0) {
                this.lastPendingReviewBlockerMsg = null;
                this.pendingReviewAutoMergeAttempts.clear();
                const mergedMsg = `Auto-merged ${mergedCount} blocker work item${mergedCount === 1 ? "" : "s"}; queued work can continue.`;
                if (display) display.addEvent(`${this.C.green}${mergedMsg}${this.C.reset}`);
                else console.log(`\n  ${this.C.green}${mergedMsg}${this.C.reset}`);
              }
            },
            afterNoMerge: () => {
              if (display) display.addEvent(`${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
              else console.log(`\n  ${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
            },
            onError: (err) => {
              const errMsg = `Auto-merge for pending-review blocker failed: ${err?.message || err}`;
              if (display) display.addEvent(`${this.C.red}${errMsg}${this.C.reset}`);
              else console.log(`\n  ${this.C.red}${errMsg}${this.C.reset}`);
              if (display) display.addEvent(`${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
              else console.log(`\n  ${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
            },
          });
        }
      } else {
        if (display) display.addEvent(`${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
        else console.log(`\n  ${this.C.yellow}${pendingReviewBlocker}${this.C.reset}`);
      }
    } else if (!pendingReviewBlocker) {
      this.idleAutoMerge.start({
        reason: "scheduler idle",
        runGc: false,
        afterMerged: (mergedCount) => {
          const mergedMsg = `Auto-merged ${mergedCount} completed work item${mergedCount === 1 ? "" : "s"} during scheduler idle.`;
          if (display) display.addEvent(`${this.C.green}${mergedMsg}${this.C.reset}`);
          else console.log(`\n  ${this.C.green}${mergedMsg}${this.C.reset}`);
        },
      });
    }
    const blocked = activeJobs.filter((j) => j.status === "blocked" || j.status === "waiting_on_human" || j.status === "waiting_on_review");
    if (blocked.length > 0 && blocked.length === activeJobs.length) {
      const msg = `All ${activeJobs.length} remaining job(s) are blocked/waiting.`;
      if (display) display.addEvent(`${this.C.yellow}${msg}${this.C.reset}`);
      else console.log(`\n  ${this.C.yellow}${msg}${this.C.reset}`);
    }
  }

  onDone() {
    const display = this.getDisplay();
    const msg = "All jobs complete.";
    if (display) display.addEvent(`${this.C.green}${this.C.bold}${msg}${this.C.reset}`);
    else console.log(`\n  ${this.C.green}${this.C.bold}${msg}${this.C.reset}`);
  }

  onBackgroundOnly({ activeJobs = [], queuedJobs = [] } = {}) {
    const display = this.getDisplay();
    if (!display) return;
    if (!this.backgroundWrapUp) {
      this.backgroundWrapUp = createRunWrapUpTracker(display, {
        subtitle: "All visible jobs are done. Finishing ATLAS background work; Enter leaves remaining ATLAS/ONNX work queued.",
      });
      this.backgroundWrapUp.done("agents");
      this.backgroundWrapUp.done("iterate");
      this.backgroundWrapUp.done("target");
      this.backgroundWrapUp.done("auto-merge", "visible jobs drained");
    }

    const byPurpose = new Map();
    for (const job of [...activeJobs, ...queuedJobs]) {
      const purpose = String(parseJobPayload(job)?.purpose || "wi");
      if (!byPurpose.has(purpose)) byPurpose.set(purpose, { active: 0, queued: 0 });
      const bucket = byPurpose.get(purpose);
      if (activeJobs.some((active) => Number(active?.id) === Number(job?.id))) bucket.active++;
      else bucket.queued++;
    }
    const activeCount = activeJobs.length;
    const queuedCount = queuedJobs.length;
    const detail = activeCount > 0
      ? `${activeCount} running${queuedCount > 0 ? `, ${queuedCount} queued` : ""}`
      : `${queuedCount} queued for next run`;
    const embeddings = byPurpose.get("embeddings") || { active: 0, queued: 0 };
    const nonEmbeddingActive = activeJobs.length - embeddings.active;
    const nonEmbeddingQueued = queuedJobs.length - embeddings.queued;

    if (nonEmbeddingActive > 0) this.backgroundWrapUp.start("atlas", detail);
    else if (nonEmbeddingQueued > 0) this.backgroundWrapUp.skip("atlas", `${nonEmbeddingQueued} queued for next run`);
    else this.backgroundWrapUp.done("atlas");

    if (embeddings.active > 0) this.backgroundWrapUp.start("onnx", `${embeddings.active} running${embeddings.queued > 0 ? `, ${embeddings.queued} queued` : ""}`);
    else if (embeddings.queued > 0) this.backgroundWrapUp.skip("onnx", `${embeddings.queued} queued for next run`);
    else this.backgroundWrapUp.done("onnx");

    if (display.isWrapUpEarlyExitRequested?.() === true) {
      for (const job of activeJobs) {
        try { this.worker.killJob(job.id, "shutdown"); } catch { /* best effort */ }
      }
      this.backgroundWrapUp.skip("atlas", "queued for next run");
      this.backgroundWrapUp.skip("onnx", "queued for next run");
    }
  }

  onSlotStatus({ blockedByLock, blockedLockDetails = [] }) {
    const display = this.getDisplay();
    if (display) {
      display._blockedByLock = blockedByLock;
      display._blockedByLockDetails = blockedLockDetails;
    }
  }
}
