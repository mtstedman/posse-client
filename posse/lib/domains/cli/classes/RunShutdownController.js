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
    finalizeRuntimeResources = null,
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
    this.closeRuntimeState = closeRuntimeState;
    this.finalizeRuntimeResources = finalizeRuntimeResources;
    this.exitProcess = exitProcess;
    this.process = processRef;
    this.sigintCount = 0;
    this.shutdownInProgress = false;
    this.shutdownForceExitTimer = null;
    this.shutdownCleanupPromise = null;
    this.shutdownSweepSummary = this.emptySweepSummary();
    this.shutdownFinishPromise = null;
    this.installed = false;
    this.forceExitIssued = false;
    this.cleanup = this.cleanup.bind(this);
    this.messageCleanup = (msg) => { if (msg === "shutdown") this.cleanup(); };
  }

  get inProgress() {
    return this.shutdownInProgress;
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    this.process.on("SIGINT", this.cleanup);
    this.process.on("SIGTERM", this.cleanup);
    if (process.platform === "win32") {
      this.process.on("SIGBREAK", this.cleanup);
      this.process.on("message", this.messageCleanup);
    }
  }

  uninstall() {
    if (!this.installed) return;
    this.installed = false;
    this.process.off("SIGINT", this.cleanup);
    this.process.off("SIGTERM", this.cleanup);
    if (process.platform === "win32") {
      this.process.off("SIGBREAK", this.cleanup);
      this.process.off("message", this.messageCleanup);
    }
  }

  observeAtlasCleanup(label) {
    try {
      const result = this.cleanupAtlasForSession?.({ label });
      if (result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    } catch { /* forced shutdown continues */ }
  }

  forceExit(label) {
    if (this.forceExitIssued) return;
    this.forceExitIssued = true;
    if (this.shutdownForceExitTimer) {
      clearTimeout(this.shutdownForceExitTimer);
      this.shutdownForceExitTimer = null;
    }
    this.uninstall();
    try { this.stopDisplaySnapshotCaches?.(); } catch { /* best effort */ }
    try { this.getDisplay()?.stop?.(); } catch { /* best effort */ }
    try { this.scheduler?.requestStop?.(); } catch { /* best effort */ }
    this.observeAtlasCleanup(label);
    try { this.closeRuntimeState?.(); } catch { /* best effort */ }
    this.process.exitCode = 1;
    this.exitProcess?.(1);
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

  cleanup() {
    this.sigintCount++;
    if (this.sigintCount >= 2) {
      this.forceExit("Forced shutdown");
      return;
    }

    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    this.worker.shuttingDown = true;
    this.shutdownForceExitTimer = setTimeout(() => {
      this.forceExit("Shutdown watchdog");
    }, 45_000);
    this.shutdownForceExitTimer.unref?.();

    let display = null;
    try { display = this.getDisplay(); } catch { /* observational */ }
    if (display) {
      try { display.cancelAllQuestions(); } catch { /* observational */ }
      try { display.addEvent(`${this.C.yellow}Graceful shutdown — killing workers, stashing work...${this.C.reset}`); } catch { /* observational */ }
      try { display.addEvent(`${this.C.dim}(Ctrl+C again to force-exit)${this.C.reset}`); } catch { /* observational */ }
      try { display.requestRender({ force: true }); } catch { /* observational */ }
    } else {
      console.log(`\n  ${this.C.yellow}Graceful shutdown — killing workers, stashing work...${this.C.reset}`);
      console.log(`  ${this.C.dim}(Ctrl+C again to force-exit)${this.C.reset}`);
    }

    let killed = 0;
    try { killed = this.worker.killAllJobs("shutdown"); } catch { /* watchdog remains armed */ }
    const fallbackStop = () => {
      try { this.scheduler?.stop?.(); } catch { /* best effort */ }
    };
    let stopPromise;
    if (typeof this.scheduleSchedulerStop !== "function") {
      fallbackStop();
      stopPromise = Promise.resolve();
    } else {
      try {
        stopPromise = Promise.resolve(this.scheduleSchedulerStop());
      } catch {
        fallbackStop();
        stopPromise = Promise.resolve();
      }
    }
    void stopPromise
      .catch(() => { fallbackStop(); })
      .then(() => this.startDirtySweep());
    if (display) {
      display.addEvent(`${this.C.dim}Sent kill to ${killed} worker(s)${this.C.reset}`);
      if (killed > 0) display.addEvent(`${this.C.dim}Workers will requeue after interruption cleanup completes${this.C.reset}`);
      display.requestRender({ force: true });
    }
  }

  async finishAfterScheduler({
    needsGit,
    schedulerStopPromise = null,
    runBoundedCloseoutWorktreeCleanup,
  } = {}) {
    if (!this.shutdownInProgress) return false;
    if (!this.shutdownFinishPromise) {
      this.shutdownFinishPromise = this.finishShutdown({
        needsGit,
        schedulerStopPromise,
        runBoundedCloseoutWorktreeCleanup,
      });
    }
    return await this.shutdownFinishPromise;
  }

  async finishShutdown({ needsGit, schedulerStopPromise, runBoundedCloseoutWorktreeCleanup }) {
    const settle = async (fn) => {
      try { return await fn?.(); } catch { return undefined; }
    };
    const emit = (message, color) => {
      try { this.emitCloseoutStatus?.(message, color); } catch { /* observational */ }
    };
    try {
      emit("Graceful shutdown - run wrap-up: starting closeout.", this.C.yellow);
      if (schedulerStopPromise) await settle(() => schedulerStopPromise);
      if (!this.shutdownCleanupPromise) this.startDirtySweep();
      if (this.shutdownCleanupPromise) {
        emit("Graceful shutdown - run wrap-up: finishing active worktree sweep...", this.C.cyan);
        await settle(() => this.flushCloseoutStatus?.());
        await settle(() => this.shutdownCleanupPromise);
      }
      if (needsGit) {
        emit("Graceful shutdown - run wrap-up: cleaning worktrees...", this.C.cyan);
        await settle(() => this.flushCloseoutStatus?.());
        const cleaned = await settle(() => runBoundedCloseoutWorktreeCleanup?.({
          label: "Graceful shutdown - run wrap-up",
          failureText: "worktree cleanup skipped",
        }));
        if (cleaned) emit("Graceful shutdown - run wrap-up: worktrees clean.", this.C.green);
      }
      await settle(() => this.flushCloseoutStatus?.());
    } finally {
      await settle(() => this.cleanupAtlasForSession?.({ label: "Graceful shutdown - run wrap-up" }));
      await settle(() => this.worker.disposeAgents?.("run_shutdown"));
      await settle(() => this.finalizeRuntimeResources?.());
      await settle(() => this.flushCloseoutStatus?.());
      // A second signal may force-exit while one of the awaited finalizers is
      // still settling. In test/injected exits the process remains alive long
      // enough to reach here; never overwrite that terminal failure with a
      // later graceful exit(0).
      if (!this.forceExitIssued) {
        emit("Graceful shutdown - run wrap-up: done.", this.C.green);
        await settle(() => this.flushCloseoutStatus?.());
        if (this.shutdownForceExitTimer) {
          clearTimeout(this.shutdownForceExitTimer);
          this.shutdownForceExitTimer = null;
        }
        this.uninstall();
        let display = null;
        try { display = this.getDisplay?.(); } catch { /* observational */ }
        try { this.stopDisplaySnapshotCaches?.(); } catch { /* best effort */ }
        try { display?.stop?.(); } catch { /* best effort */ }
        if (display) {
          try { console.log(`\n  ${this.C.green}Graceful shutdown complete.${this.C.reset}\n`); } catch { /* observational */ }
        }
        try { this.closeRuntimeState?.(); } catch { /* best effort */ }
        this.process.exitCode = 0;
        this.exitProcess?.(0);
      }
    }
    return true;
  }
}
