import { ACTIVE_LEASE_STATUSES } from "../../../catalog/job.js";
import { closeRuntimeStateForExit } from "../functions/run-session.js";

export class RunShutdownController {
  constructor({
    getDisplay = () => null,
    worker,
    scheduler,
    scheduleSchedulerStop,
    stopDisplaySnapshotCaches,
    cleanupAtlasForSession,
    emitCloseoutStatus,
    flushCloseoutStatus,
    C,
    listJobs,
    requeueForShutdown = null,
    refreshWorkItemStatus = null,
    closeRuntimeState = closeRuntimeStateForExit,
    exitProcess = process.exit,
    processRef = process,
  } = {}) {
    this.getDisplay = getDisplay;
    this.worker = worker;
    this.scheduler = scheduler;
    this.scheduleSchedulerStop = scheduleSchedulerStop;
    this.stopDisplaySnapshotCaches = stopDisplaySnapshotCaches;
    this.cleanupAtlasForSession = cleanupAtlasForSession;
    this.emitCloseoutStatus = emitCloseoutStatus;
    this.flushCloseoutStatus = flushCloseoutStatus;
    this.C = C;
    this.listJobs = listJobs;
    this.requeueForShutdown = requeueForShutdown;
    this.refreshWorkItemStatus = refreshWorkItemStatus;
    this.closeRuntimeState = closeRuntimeState;
    this.exitProcess = exitProcess;
    this.process = processRef;
    this.sigintCount = 0;
    this.shutdownInProgress = false;
    this.shutdownForceExitTimer = null;
    this.shutdownCleanupPromise = null;
    this.shutdownSweepSummary = this.emptySweepSummary();
    this.cleanup = this.cleanup.bind(this);
    this.messageCleanup = (msg) => { if (msg === "shutdown") this.cleanup(); };
  }

  get inProgress() {
    return this.shutdownInProgress;
  }

  install() {
    this.process.on("SIGINT", this.cleanup);
    this.process.on("SIGTERM", this.cleanup);
    if (process.platform === "win32") {
      this.process.on("SIGBREAK", this.cleanup);
      this.process.on("message", this.messageCleanup);
    }
  }

  uninstall() {
    this.process.off("SIGINT", this.cleanup);
    this.process.off("SIGTERM", this.cleanup);
    if (process.platform === "win32") {
      this.process.off("SIGBREAK", this.cleanup);
      this.process.off("message", this.messageCleanup);
    }
  }

  emptySweepSummary() {
    return {
      swept: 0,
      snapshotted: 0,
      skippedDueBudget: 0,
      skippedActive: 0,
      skippedLockTimeout: 0,
      resetIncomplete: 0,
    };
  }

  normalizeSweepSummary(swept) {
    return {
      ...this.emptySweepSummary(),
      ...(swept || {}),
    };
  }

  sweepSummaryLine(swept) {
    return `Shutdown dirty sweep: ${swept.swept} active worktree(s), ${swept.snapshotted} snapshot(s)${swept.skippedDueBudget ? `, ${swept.skippedDueBudget} skipped (time budget)` : ""}${swept.skippedActive ? `, ${swept.skippedActive} skipped (active sentinel)` : ""}${swept.skippedLockTimeout ? `, ${swept.skippedLockTimeout} skipped (lock busy)` : ""}${swept.resetIncomplete ? `, ${swept.resetIncomplete} incomplete reset(s)` : ""}${swept.sweepFailed ? `, skipped (${swept.error})` : ""}`;
  }

  reportSweep(swept) {
    const display = this.getDisplay();
    if (display) {
      if (swept.swept > 0) {
        display.addEvent(`${this.C.dim}${this.sweepSummaryLine(swept)}${this.C.reset}`);
      } else if (swept.skippedLockTimeout > 0) {
        display.addEvent(`${this.C.dim}Shutdown dirty sweep skipped ${swept.skippedLockTimeout} worktree(s): lock busy${this.C.reset}`);
      } else if (swept.sweepFailed) {
        display.addEvent(`${this.C.dim}Shutdown dirty sweep skipped: ${swept.error}${this.C.reset}`);
      }
      display.requestRender({ force: true });
    } else if (swept.swept > 0 || swept.skippedLockTimeout > 0 || swept.sweepFailed) {
      console.log(`  ${this.C.dim}${this.sweepSummaryLine(swept)}${this.C.reset}`);
    }
  }

  startDirtySweep() {
    if (this.shutdownCleanupPromise) return this.shutdownCleanupPromise;
    this.shutdownCleanupPromise = Promise.resolve()
      .then(async () => {
        if (typeof this.worker.sweepActiveDirtyWorktreesAsync !== "function") {
          return {
            ...this.emptySweepSummary(),
            sweepFailed: true,
            error: "async dirty sweep unavailable",
          };
        }
        return this.worker.sweepActiveDirtyWorktreesAsync("shutdown-signal", {
          maxTotalMs: 2000,
          worktreeLockWaitMs: 250,
        });
      })
      .then((swept) => {
        this.shutdownSweepSummary = this.normalizeSweepSummary(swept);
        this.reportSweep(this.shutdownSweepSummary);
        return this.shutdownSweepSummary;
      })
      .catch((err) => {
        this.shutdownSweepSummary = {
          ...this.emptySweepSummary(),
          sweepFailed: true,
          error: err?.message || String(err),
        };
        this.reportSweep(this.shutdownSweepSummary);
        return this.shutdownSweepSummary;
      });
    return this.shutdownCleanupPromise;
  }

  requeueInterruptedJobs() {
    if (typeof this.requeueForShutdown !== "function") return { active: 0, requeued: 0 };
    let active = [];
    try {
      active = this.listJobs([...ACTIVE_LEASE_STATUSES]);
    } catch {
      return { active: 0, requeued: 0 };
    }
    let requeued = 0;
    const affectedWorkItems = new Set();
    for (const job of active) {
      if (!job?.id) continue;
      if (job.work_item_id != null) affectedWorkItems.add(job.work_item_id);
      try {
        if (this.requeueForShutdown(job.id)) requeued += 1;
      } catch { /* best-effort; scheduler/boot repair remains the fallback */ }
    }
    for (const wiId of affectedWorkItems) {
      try { this.refreshWorkItemStatus?.(wiId); } catch { /* best-effort */ }
    }
    return { active: active.length, requeued };
  }

  cleanup() {
    this.sigintCount++;
    if (this.sigintCount >= 2) {
      this.stopDisplaySnapshotCaches();
      if (this.getDisplay()) this.getDisplay().stop();
      try { this.scheduler.requestStop?.(); } catch { /* best-effort */ }
      void this.cleanupAtlasForSession({ label: "Forced shutdown" });
      this.closeRuntimeState();
      this.process.exit(1);
    }

    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    this.worker.shuttingDown = true;
    this.shutdownForceExitTimer = setTimeout(() => {
      this.stopDisplaySnapshotCaches();
      if (this.getDisplay()) this.getDisplay().stop();
      try { this.scheduler.requestStop?.(); } catch { /* best-effort */ }
      void this.cleanupAtlasForSession({ label: "Shutdown watchdog" });
      this.closeRuntimeState();
      this.process.exit(1);
    }, 45_000);
    this.shutdownForceExitTimer.unref?.();

    const display = this.getDisplay();
    if (display) {
      display.cancelAllQuestions();
      display.addEvent(`${this.C.yellow}Graceful shutdown — killing workers, stashing work...${this.C.reset}`);
      display.addEvent(`${this.C.dim}(Ctrl+C again to force-exit)${this.C.reset}`);
      display.requestRender({ force: true });
    } else {
      console.log(`\n  ${this.C.yellow}Graceful shutdown — killing workers, stashing work...${this.C.reset}`);
      console.log(`  ${this.C.dim}(Ctrl+C again to force-exit)${this.C.reset}`);
    }

    const killed = this.worker.killAllJobs("shutdown");
    const shutdownRequeue = this.requeueInterruptedJobs();
    void this.scheduleSchedulerStop().then(() => this.startDirtySweep());
    if (display) {
      display.addEvent(`${this.C.dim}Sent kill to ${killed} worker(s)${this.C.reset}`);
      if (shutdownRequeue.requeued > 0) {
        display.addEvent(`${this.C.dim}Requeued ${shutdownRequeue.requeued} interrupted job(s) for next run${this.C.reset}`);
      } else if (shutdownRequeue.active > 0) {
        display.addEvent(`${this.C.dim}Shutdown requeue deferred for ${shutdownRequeue.active} active job(s); boot repair will retry${this.C.reset}`);
      }
      display.requestRender({ force: true });
    }
  }

  async finishAfterScheduler({
    needsGit,
    schedulerStopPromise = null,
    runBoundedCloseoutWorktreeCleanup,
  } = {}) {
    if (!this.shutdownInProgress) return false;
    this.emitCloseoutStatus("Graceful shutdown - run wrap-up: starting closeout.", this.C.yellow);
    if (schedulerStopPromise) await schedulerStopPromise;
    if (!this.shutdownCleanupPromise) this.startDirtySweep();
    if (this.shutdownCleanupPromise) {
      this.emitCloseoutStatus("Graceful shutdown - run wrap-up: finishing active worktree sweep...", this.C.cyan);
      await this.flushCloseoutStatus();
      await this.shutdownCleanupPromise;
    }
    if (needsGit) {
      this.emitCloseoutStatus("Graceful shutdown - run wrap-up: cleaning worktrees...", this.C.cyan);
      await this.flushCloseoutStatus();
      const cleaned = await runBoundedCloseoutWorktreeCleanup({
        label: "Graceful shutdown - run wrap-up",
        failureText: "worktree cleanup skipped",
      });
      if (cleaned) this.emitCloseoutStatus("Graceful shutdown - run wrap-up: worktrees clean.", this.C.green);
    }
    await this.flushCloseoutStatus();
    await this.cleanupAtlasForSession({ label: "Graceful shutdown - run wrap-up" });
    await this.flushCloseoutStatus();
    this.emitCloseoutStatus("Graceful shutdown - run wrap-up: done.", this.C.green);
    await this.flushCloseoutStatus();
    if (this.shutdownForceExitTimer) {
      clearTimeout(this.shutdownForceExitTimer);
      this.shutdownForceExitTimer = null;
    }

    this.uninstall();
    const hadDisplay = !!this.getDisplay();
    this.stopDisplaySnapshotCaches();
    if (this.getDisplay()) this.getDisplay().stop();
    if (hadDisplay) console.log(`\n  ${this.C.green}Graceful shutdown complete.${this.C.reset}\n`);
    this.closeRuntimeState();
    process.exitCode = 0;
    this.exitProcess?.(0);
    return true;
  }
}
