import { log } from "../../../shared/telemetry/functions/logging/logger.js";

// Own the boot phase race and its lock-release decisions while Scheduler
// retains the public lifecycle facade.
export async function coordinateSchedulerBoot(scheduler, { onBeforeLoop, onBeforeLoopFatal = false, onBootEvent = null, onBootAbort = null } = {}) {
  const emitBootEvent = (label, patch) => {
    if (typeof onBootEvent !== "function") return;
    try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
  };
  if (!(await scheduler.acquireBootLock({ onBootEvent }))) return false;
  // ── BOOT PHASES 2 & 3 in parallel ───────────────────────────────────────
  // Orphan recovery touches the orchestrator DB (jobs / job_attempts /
  // *_locks). Pre-loop hooks (provider warmups, ATLAS warmup) touch the
  // network and .posse/atlas/* files. Disjoint storage, no write contention
  // — so they race instead of serializing. This is what unblocks the
  // per-language indexers from waiting on orphan recovery to finish.
  /** @type {Error | null} */
  let preLoopErr = null;
  const recoverP = scheduler.recoverOrphans({ onBootEvent }).catch((err) => {
    scheduler._log(`Boot: orphan recovery failed: ${err?.message || err}`, "red");
    throw err;
  });
  const preLoopP = (async () => {
    if (!onBeforeLoop) return;
    scheduler._log("Boot: running pre-loop hooks...");
    emitBootEvent("pre-loop hooks", { section: "scheduler", status: "running" });
    try {
      await onBeforeLoop();
      emitBootEvent("pre-loop hooks", { section: "scheduler", status: "ok" });
    } catch (err) {
      scheduler._log(`Boot: onBeforeLoop failed: ${err.message}`, "yellow");
      emitBootEvent("pre-loop hooks", { section: "scheduler", status: "failed", detail: err.message });
      if (onBeforeLoopFatal) preLoopErr = err;
    }
  })();
  // Outer boot timeout — last-resort wedge backstop. Per-step soft timeouts
  // (bootWarmup softTimeoutMs, internal worker timeouts) handle ordinary
  // slow paths. This 45-min race ceiling only fires if ALL of those failed
  // to arm — e.g. a sync DB lock that froze the event loop before any
  // timer could be registered. Boot fails loudly instead of hanging forever.
  const SCHEDULER_BOOT_OUTER_TIMEOUT_MS = 45 * 60 * 1000;
  /** @type {NodeJS.Timeout | null} */
  let bootTimeoutTimer = null;
  // Do not release boot ownership on the first rejection while the sibling
  // phase is still running. In particular, orphan-recovery failure used to
  // unwind RunSession cleanup while pre-loop warmups could continue and
  // recreate resources behind the closed supervisor. Preserve the original
  // rejection after both phases settle; the outer timeout remains the hard
  // ceiling for a genuinely wedged sibling.
  const bootPhases = Promise.allSettled([recoverP, preLoopP]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  });
  const bootRace = Promise.race([
    bootPhases,
    new Promise((_, reject) => {
      bootTimeoutTimer = setTimeout(() => {
        const err = new Error(`Scheduler boot exceeded outer ${SCHEDULER_BOOT_OUTER_TIMEOUT_MS / 60000}min timeout — a step is wedged`);
        /** @type {any} */ (err).code = "SCHEDULER_BOOT_TIMEOUT";
        reject(err);
      }, SCHEDULER_BOOT_OUTER_TIMEOUT_MS);
      bootTimeoutTimer?.unref?.();
    }),
  ]);
  try {
    await bootRace;
  } catch (err) {
    if (bootTimeoutTimer) clearTimeout(bootTimeoutTimer);
    try { onBootAbort?.(err); } catch { /* best-effort cooperative cancellation */ }
    if (/** @type {any} */ (err)?.code === "SCHEDULER_BOOT_TIMEOUT") {
      scheduler._log(`Boot: ${err.message}`, "red");
      emitBootEvent("pre-loop hooks", { section: "scheduler", status: "failed", detail: err.message });
      log.warn("scheduler", "Scheduler boot outer timeout fired", { timeoutMs: SCHEDULER_BOOT_OUTER_TIMEOUT_MS });
      scheduler.stop();
      return false;
    }
    scheduler.stop();
    throw err;
  }
  if (bootTimeoutTimer) clearTimeout(bootTimeoutTimer);
  if (preLoopErr) {
    scheduler._log("Boot: decision=EXIT (fatal pre-loop hook failed)", "red");
    scheduler.stop();
    return false;
  }
  if (scheduler._lockLost) {
    // Renewal can lose the lock while orphan recovery / pre-loop hooks run
    // (renewal starts at lock acquisition). _stopForSchedulerLockLoss only
    // sets _lockLost/_running — without this check boot would "complete"
    // and runLoop would throw instead of reporting a clean boot failure.
    scheduler._log("Boot: decision=EXIT (scheduler lock lost during boot phases)", "red");
    scheduler.stop();
    return false;
  }
  if (scheduler._stopRequested) {
    scheduler._log("Boot: decision=EXIT (stop requested during pre-loop hooks)", "yellow");
    scheduler.stop();
    return false;
  }
  try {
    await scheduler.runHealthChecks({ onBootEvent });
    if (scheduler._lockLost) {
      scheduler._log("Boot: decision=EXIT (scheduler lock lost during health checks)", "red");
      scheduler.stop();
      return false;
    }
    if (scheduler._stopRequested) {
      scheduler._log("Boot: decision=EXIT (stop requested during health checks)", "yellow");
      scheduler.stop();
      return false;
    }
    scheduler.markBootComplete({ onBootEvent });
    return true;
  } catch (err) {
    // Every failure after lock acquisition must converge on the same release
    // path. Health probes are external I/O and can reject after orphan and
    // pre-loop recovery succeeded; without this guard the scheduler lock and
    // renewal timer survived the failed boot.
    scheduler.stop();
    throw err;
  }
}
