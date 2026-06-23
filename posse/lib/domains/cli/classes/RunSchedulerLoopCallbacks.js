import { displayRoleForJobType } from "../../providers/functions/roles.js";

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
  }

  callbacks() {
    return {
      onJobStart: (job) => this.onJobStart(job),
      onJobEnd: (job) => this.onJobEnd(job),
      onIdle: (activeJobs) => this.onIdle(activeJobs),
      onDone: () => this.onDone(),
      onSlotStatus: (status) => this.onSlotStatus(status),
      onKillJob: (jobId, reason) => this.worker.killJob(jobId, reason),
    };
  }

  onJobStart(job) {
    const display = this.getDisplay();
    if (!display) return;
    const role = displayRoleForJobType(job.job_type);
    const titleClean = job.title.replace(/^(Research|Plan|Ask|Fix|Assess|Dev):\s*/i, "").slice(0, 50);
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
    if (display) {
      const freshJob = this.getJob(job.id);
      display.removeWorker(job.id, freshJob?.status || "done");
    }
    const freshJob = this.getJob(job.id);
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

  onSlotStatus({ blockedByLock, blockedLockDetails = [] }) {
    const display = this.getDisplay();
    if (display) {
      display._blockedByLock = blockedByLock;
      display._blockedByLockDetails = blockedLockDetails;
    }
  }
}
