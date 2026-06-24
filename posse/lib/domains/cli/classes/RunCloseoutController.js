import { parseJobPayload } from "../../queue/functions/payload.js";
import { firstLine } from "../functions/run-session.js";

const ATLAS_WRAPUP_DRAIN_BUDGET_MS = 10 * 60 * 1000;
const ATLAS_WRAPUP_DRAIN_MAX_READY_WAIT_MS = 30 * 1000;
const WORKTREE_CLOSEOUT_CLEANUP_TIMEOUT_MS = 90 * 1000;

export class RunCloseoutController {
  constructor({
    getDisplay = () => null,
    getScheduler = () => null,
    getWorker = () => null,
    C,
    log = null,
    projectDir,
    listJobs,
    startupWorktreeCleanup = null,
    isAtlasRuntimeDisabled = null,
    getAtlasRuntimeDisabledReason = null,
    setConductorKeepWarm = null,
    closeSharedConductor = null,
    setOnnxDaemonKeepWarm = null,
    closeSharedOnnxDaemon = null,
  } = {}) {
    this.getDisplay = getDisplay;
    this.getScheduler = getScheduler;
    this.getWorker = getWorker;
    this.C = C;
    this.log = log;
    this.projectDir = projectDir;
    this.listJobs = listJobs;
    this.startupWorktreeCleanup = startupWorktreeCleanup;
    this.isAtlasRuntimeDisabled = isAtlasRuntimeDisabled;
    this.getAtlasRuntimeDisabledReason = getAtlasRuntimeDisabledReason;
    this.setConductorKeepWarm = setConductorKeepWarm;
    this.closeSharedConductor = closeSharedConductor;
    this.setOnnxDaemonKeepWarm = setOnnxDaemonKeepWarm;
    this.closeSharedOnnxDaemon = closeSharedOnnxDaemon;
  }

  hasLiveDisplay() {
    const display = this.getDisplay();
    return !!(display && display._started !== false && typeof display.addEvent === "function");
  }

  emitStatus(message, color = this.C.dim) {
    const display = this.getDisplay();
    const line = `${color}${message}${this.C.reset}`;
    if (this.hasLiveDisplay()) {
      display.addEvent(line);
      display.requestRender?.({ force: true });
    } else {
      console.log(`  ${line}`);
    }
  }

  async flushStatus() {
    if (this.hasLiveDisplay()) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async cleanupAtlasForSession({ label = "Run wrap-up", announce = true } = {}) {
    const display = this.getDisplay();
    const displayStatus = announce && this.hasLiveDisplay();
    const startedAt = Date.now();
    if (announce) {
      if (displayStatus) {
        display.setRunPhase?.("ATLAS cleanup");
        display.setBlockingOverlay?.("ATLAS cleanup", "Closing ATLAS v2 resources.");
      }
      this.emitStatus(`${label}: ATLAS cleanup...`, this.C.cyan);
      await this.flushStatus();
    }
    try { this.setConductorKeepWarm?.(false); await this.closeSharedConductor?.(); } catch { /* best-effort */ }
    try { this.setOnnxDaemonKeepWarm?.(false); await this.closeSharedOnnxDaemon?.(); } catch { /* best-effort */ }
    if (announce) {
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      this.emitStatus(`${label}: ATLAS cleanup complete (${elapsedSec}s).`, this.C.green);
    }
    if (displayStatus) {
      display.setBlockingOverlay?.(null);
      display.setRunPhase?.(label);
    }
    if (announce) await this.flushStatus();
  }

  wrapUpAtlasDrainEnabled() {
    const raw = String(process.env.POSSE_WRAPUP_ATLAS_DRAIN ?? "").trim().toLowerCase();
    return !(raw && ["off", "false", "0", "no"].includes(raw));
  }

  async drainPendingAtlasWarmJobs({
    label = "Run wrap-up",
    shouldExitEarly = null,
    includeEmbeddings = false,
  } = {}) {
    if (!this.wrapUpAtlasDrainEnabled()) return { ran: 0, remaining: 0 };
    const atlasDisabledForRun = (() => {
      try { return typeof this.isAtlasRuntimeDisabled === "function" && this.isAtlasRuntimeDisabled(this.projectDir); } catch { return false; }
    })();
    const queuedWarms = () => {
      try {
        return this.listJobs(["queued"]).filter((j) => j.job_type === "atlas_warm");
      } catch {
        return [];
      }
    };
    if (atlasDisabledForRun) {
      const remaining = queuedWarms().length;
      if (remaining > 0) {
        const reason = (() => {
          try { return typeof this.getAtlasRuntimeDisabledReason === "function" ? this.getAtlasRuntimeDisabledReason(this.projectDir) : null; } catch { return null; }
        })();
        const tail = reason ? ` (${reason})` : "";
        this.emitStatus(`${label}: ATLAS disabled for this run${tail}; leaving ${remaining} queued warm job(s) for next boot.`, this.C.yellow);
        await this.flushStatus();
      }
      return { ran: 0, remaining };
    }
    const exitRequested = () => {
      try { return typeof shouldExitEarly === "function" && shouldExitEarly() === true; } catch { return false; }
    };
    const drainableWarm = (j) => includeEmbeddings || String(parseJobPayload(j)?.purpose || "wi") !== "embeddings";
    const deadline = Date.now() + ATLAS_WRAPUP_DRAIN_BUDGET_MS;
    let ran = 0;
    let announced = false;
    try {
      while (Date.now() < deadline) {
        if (exitRequested()) break;
        const pending = queuedWarms().filter(drainableWarm);
        if (pending.length === 0) break;
        if (!announced) {
          announced = true;
          if (this.hasLiveDisplay()) this.getDisplay().setRunPhase?.("ATLAS index finish");
          this.emitStatus(`${label}: finishing ${pending.length} queued ATLAS warm job(s) before exit...`, this.C.cyan);
          await this.flushStatus();
        }
        const now = Date.now();
        const readyAtMs = (j) => (j.ready_at ? new Date(j.ready_at).getTime() : 0);
        const job = pending.find((j) => readyAtMs(j) <= now);
        if (!job) {
          const earliest = Math.min(...pending.map(readyAtMs));
          if (earliest - now > ATLAS_WRAPUP_DRAIN_MAX_READY_WAIT_MS) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(100, earliest - now))));
          continue;
        }
        if (exitRequested()) break;
        const scheduler = this.getScheduler();
        const worker = this.getWorker();
        const acquireWithLocks = typeof scheduler?.leaseManager?.acquireWithLocksAsync === "function"
          ? scheduler.leaseManager.acquireWithLocksAsync.bind(scheduler.leaseManager)
          : scheduler?.leaseManager?.acquireWithLocks?.bind(scheduler.leaseManager);
        if (typeof acquireWithLocks !== "function" || !worker) break;
        const lease = await acquireWithLocks(job, scheduler.ownerId, null, scheduler.leaseSec);
        if (!lease) break;
        const purpose = String(parseJobPayload(job)?.purpose || "wi");
        this.emitStatus(`${label}: ATLAS warm (${purpose})...`, this.C.cyan);
        await this.flushStatus();
        try {
          await worker.execute({ ...job, _leaseToken: lease.leaseToken });
          ran += 1;
        } catch (err) {
          this.emitStatus(`${label}: ATLAS warm (${purpose}) failed — ${String(err?.message || err).slice(0, 160)}`, this.C.yellow);
          break;
        }
      }
    } catch { /* drain is best-effort; never block exit */ }
    const remaining = queuedWarms().length;
    if (announced) {
      this.emitStatus(
        exitRequested()
          ? `${label}: ATLAS drain skipped by operator — ${remaining} warm job(s) left for next boot.`
          : remaining === 0
          ? `${label}: ATLAS index work finished (${ran} warm job(s)).`
          : `${label}: ATLAS drain stopped — ${remaining} warm job(s) left for next boot.`,
        !exitRequested() && remaining === 0 ? this.C.green : this.C.yellow,
      );
      await this.flushStatus();
    }
    return { ran, remaining };
  }

  async runBoundedCloseoutWorktreeCleanup({
    label = "Run wrap-up",
    failureText = "worktree cleanup skipped",
  } = {}) {
    if (typeof this.startupWorktreeCleanup !== "function") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`worktree cleanup timed out after ${Math.ceil(WORKTREE_CLOSEOUT_CLEANUP_TIMEOUT_MS / 1000)}s`));
    }, WORKTREE_CLOSEOUT_CLEANUP_TIMEOUT_MS);
    timer.unref?.();
    try {
      await this.startupWorktreeCleanup({
        signal: controller.signal,
        skipDirtyTreeGuard: true,
        onMsg: (msg) => this.emitStatus(`${label}: ${msg}`, this.C.dim),
      });
      return true;
    } catch (err) {
      this.emitStatus(`${label}: ${failureText} (${firstLine(err?.message || err)}).`, this.C.yellow);
      await this.flushStatus();
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async cleanupResidualWorktreesAfterAtlas({ label = "Run wrap-up" } = {}) {
    await this.runBoundedCloseoutWorktreeCleanup({
      label,
      failureText: "post-ATLAS worktree cleanup skipped",
    });
  }
}
