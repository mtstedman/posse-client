// Runtime session orchestration for the run command.
// Keeps the CLI entry point thin while preserving the existing command behavior.

import readline from "readline";
import { displayRoleForJobType } from "../../providers/functions/roles.js";
import { ensureRemoteCatalogLoaded, getRemoteCatalog } from "../../providers/functions/model-catalog-store.js";
import { describeModelCatalogWarning, validateConfiguredModels } from "../../providers/functions/model-catalog-validate.js";
import { maybeRefreshModelCatalog } from "../../remote/functions/model-catalog-refresh.js";
import { cancelOpenPushOfferGates } from "../../queue/functions/push-offer.js";
import {
  RUNTIME_STATUS_KEYS,
  clearRuntimeStatus,
  markCleanShutdown,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { createBootPanel } from "./boot-panel.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import { inspectLocalOnnxStatus } from "../../atlas/functions/v2/embeddings/local-onnx.js";
import { setConductorKeepWarm, closeSharedConductor } from "../../atlas/functions/v2/parse/conductor.js";
import { renderNeuralNetworkBanner } from "../../ui/functions/display/neural-network-banner.js";
import { getOnnxWarmState, resetOnnxWarmState, setOnnxWarmState } from "../../atlas/functions/v2/embeddings/onnx-warm-state.js";
import { recordEmbeddingForensics } from "../../atlas/functions/v2/embeddings/forensics.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { flushEventsNow } from "../../queue/functions/events.js";
import { closeLog } from "../../../shared/telemetry/functions/logging/logger.js";
import { closeOutputLog } from "../../../shared/telemetry/functions/logging/output-log.js";
import { closePromptLog } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeObservationLog } from "../../observability/functions/observations.js";
import { recordRunDiagnostic } from "../../../shared/telemetry/functions/run-diagnostics.js";
import { ensureBootDependenciesInWorker, formatBootDependencySync } from "../../system/functions/dependency-sync.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { LOCK_HOLDING_JOB_STATUSES } from "../../../catalog/job.js";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { fit as fitAnsi } from "../../../shared/format/functions/ansi.js";

export const PROVIDER_AUTH_WARMUP_TIMEOUT_MS = 30_000;
export const PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS = 1_200;

const TUI_SNAPSHOT_WORKER_URL = new URL("./tui-snapshot-worker.js", import.meta.url);
const TUI_SNAPSHOT_THREAD_MANAGER = new ThreadManager();
const EMPTY_TOOL_SNAPSHOT = { jobs: [], recent: [], activeLocks: { work_items: [], jobs: [] } };

/**
 * @param {{ stdout?: any, stderr?: any }} [input]
 */
export function createTerminalOutputIntercept({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const origStdoutWrite = stdout.write.bind(stdout);
  const origStderrWrite = stderr?.write?.bind(stderr);
  /** @type {Array<{stream: "stdout" | "stderr", data: string | Buffer, encoding?: string}>} */
  const buffer = [];
  let stdoutActive = false;
  let stderrActive = false;
  const bufferedWrite = (streamName) => (chunk, encoding, callback) => {
    const cb = typeof encoding === "function" ? encoding : callback;
    const enc = typeof encoding === "string" ? encoding : undefined;
    buffer.push({ stream: streamName, data: chunk, encoding: enc });
    if (typeof cb === "function") cb();
    return true;
  };

  const install = () => {
    if (!stdout?.isTTY) return;
    if (!stdoutActive) {
      stdoutActive = true;
      stdout.write = bufferedWrite("stdout");
    }
    if (stderr?.isTTY && origStderrWrite && !stderrActive) {
      stderrActive = true;
      stderr.write = bufferedWrite("stderr");
    }
  };

  const release = () => {
    if (!stdoutActive && !stderrActive) return;
    if (stdoutActive) {
      stdout.write = origStdoutWrite;
      stdoutActive = false;
    }
    if (stderrActive) {
      stderr.write = origStderrWrite;
      stderrActive = false;
    }
    for (const entry of buffer) {
      try {
        const write = entry.stream === "stderr" ? origStderrWrite : origStdoutWrite;
        if (!write) continue;
        if (entry.encoding) write(entry.data, entry.encoding);
        else write(entry.data);
      } catch { /* observational */ }
    }
    buffer.length = 0;
  };

  return {
    install,
    release,
    writeStdout: origStdoutWrite,
    get active() { return stdoutActive || stderrActive; },
    get bufferedCount() { return buffer.length; },
  };
}

function runTuiSnapshotTask(task, { projectDir, dbPath }) {
  return TUI_SNAPSHOT_THREAD_MANAGER.run(TUI_SNAPSHOT_WORKER_URL, {
    label: `TUI ${task} snapshot`,
    timeoutMs: 5_000,
    workerData: {
      task,
      args: { projectDir, dbPath },
    },
  });
}

function createAsyncSnapshotCache({
  initialValue,
  minIntervalMs = 750,
  load,
  onUpdate = null,
  onError = null,
} = {}) {
  let value = initialValue;
  let inFlight = null;
  let lastStartedAt = 0;
  let stopped = false;

  const refresh = ({ force = false } = {}) => {
    if (stopped || typeof load !== "function") return Promise.resolve(value);
    const now = Date.now();
    if (inFlight) return inFlight;
    if (!force && now - lastStartedAt < minIntervalMs) return Promise.resolve(value);
    lastStartedAt = now;
    inFlight = Promise.resolve()
      .then(load)
      .then((next) => {
        if (next !== undefined) {
          value = next;
          if (typeof onUpdate === "function") onUpdate(value);
        }
        return value;
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    get: () => value,
    refresh,
    stop: () => { stopped = true; },
  };
}

export function buildImageInjectionPayload({ prompt = "", outputRoot = "" } = {}) {
  const normalizedOutputRoot = String(outputRoot || "").replace(/\\/g, "/");
  const expectedImagePath = normalizedOutputRoot ? `${normalizedOutputRoot}/image.png` : "image.png";
  return {
    task_spec: [
      "Generate an image based on this description:",
      "",
      prompt,
      "",
      "Use the generate_image tool to create the image.",
      "Save it to: image.png (your working directory is the output folder).",
      "Use quality \"high\" for best results.",
    ].join("\n"),
    task_mode: "image",
    needs_image_generation: true,
    output_root: normalizedOutputRoot,
    create_roots: normalizedOutputRoot ? [normalizedOutputRoot] : [],
    files_to_modify: [],
    files_to_create: [expectedImagePath],
    success_criteria: [
      `${expectedImagePath} exists`,
      "Image is a valid PNG/JPG/WebP",
    ],
  };
}

export function closeRuntimeStateForExit() {
  // Record the clean shutdown FIRST (needs the DB open) so the bridge
  // derives `offline` instead of `stalled` once the heartbeat ages out.
  try { markCleanShutdown(); } catch { /* best effort */ }
  try { flushEventsNow(); } catch { /* best effort */ }
  try { closePromptLog(); } catch { /* best effort */ }
  try { closeOutputLog(); } catch { /* best effort */ }
  try { closeObservationLog(); } catch { /* best effort */ }
  try { closeLog(); } catch { /* best effort */ }
  try { closeDb(); } catch { /* best effort */ }
}

export function handleWrapUpSignal({
  signal = "SIGINT",
  display = null,
  cleanupAtlasForSession = null,
  closeRuntimeState = closeRuntimeStateForExit,
  exit = process.exit,
} = {}) {
  if (display) display.stop();
  const code = signal === "SIGTERM" ? 143 : 130;
  process.exitCode = code;
  const finish = () => {
    closeRuntimeState?.();
    exit(code);
  };
  try {
    const stopResult = cleanupAtlasForSession?.({ label: "Interrupted wrap-up" });
    if (stopResult && typeof stopResult.then === "function") {
      return stopResult.finally(finish);
    }
  } catch {
    // Best-effort shutdown still needs to close local state and exit.
  }
  finish();
}

export function bootScipLangPatchFromEvent(event = {}) {
  const kind = String(event.kind || "");
  const stage = String(event.stage || "");
  const percent = Number(event.percent ?? event.language_percent);
  const current = Number(event.language_current ?? event.current ?? event.progress_current);
  const total = Number(event.language_total ?? event.total ?? event.progress_total);
  const countPatch = {};
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    countPatch.current = current;
    countPatch.total = total;
  }
  if (Number.isFinite(percent)) countPatch.percent = percent;

  if (kind === "atlas.scip.restage_failed") {
    return {
      state: "failed",
      percent: 100,
      detail: event.text || "failed",
    };
  }
  if (kind === "atlas.scip.restage_completed") {
    return {
      state: "indexing",
      percent: 100,
      detail: "indexed",
    };
  }
  if (kind === "atlas.scip.ingest.skipped") {
    return { state: "done", percent: 100, detail: "already ingested" };
  }
  if (kind === "atlas.scip.ingest.completed") {
    const ingested = Number(event.documents_ingested || 0);
    const failed = Number(event.documents_failed || 0);
    const skipped = Number(event.documents_skipped || 0);
    const reused = Number(event.blobs_reused || 0);
    const processed = Number(event.total ?? (ingested + reused + skipped + failed));
    return {
      state: "done",
      current: Number.isFinite(processed) ? processed : ingested,
      total: Number.isFinite(processed) ? processed : ingested + failed,
      percent: 100,
      detail: processed > 0 ? `${processed} docs` : "indexed",
    };
  }
  if (kind === "atlas.scip.ingest.started" || kind === "atlas.scip.ingest.progress") {
    if (!(Number.isFinite(total) && total > 0) && !Number.isFinite(percent)) {
      return {
        state: "indexing",
        ...countPatch,
        detail: event.text || "preparing intake",
      };
    }
    return {
      state: "intaking",
      ...countPatch,
      detail: event.text || "intaking",
    };
  }
  if (kind === "atlas.scip.restage_started"
      || kind === "atlas.scip.restage_decided"
      || stage === "scip.indexing"
      || stage === "scip") {
    return {
      state: "indexing",
      ...countPatch,
      detail: event.text || "",
    };
  }
  return null;
}

export function scopeScipEventToSourceLanguage(event = {}, lang = "") {
  const key = String(lang || "").trim().toLowerCase();
  if (!key) return event;
  const currentByLang = event.source_language_current || event.sourceLanguageCurrent || null;
  const totalByLang = event.source_language_total || event.sourceLanguageTotal || event.source_language_totals || event.sourceLanguageTotals || null;
  const current = countForLanguage(currentByLang, key);
  const total = countForLanguage(totalByLang, key);
  const hasScopedCount = Number.isFinite(current) || Number.isFinite(total);
  const scopedCurrent = Number.isFinite(current) ? current : 0;
  const scopedTotal = Number.isFinite(total) ? total : 0;
  return {
    ...event,
    language: key,
    indexer_language: event.indexer_language || event.indexer || event.language || languageFromScipScheme(event.scheme),
    ...(hasScopedCount
      ? {
          current: scopedCurrent,
          total: scopedTotal,
          language_current: scopedCurrent,
          language_total: scopedTotal,
          percent: scopedTotal > 0 ? (scopedCurrent / scopedTotal) * 100 : event.percent,
        }
      : {}),
  };
}

function languageFromScipScheme(scheme) {
  return String(scheme || "").trim().toLowerCase().replace(/^scip-/, "");
}

function countForLanguage(counts, lang) {
  if (!counts) return NaN;
  if (counts instanceof Map) return Number(counts.get(lang));
  if (typeof counts === "object") return Number(counts[lang]);
  return NaN;
}

export class RunSession {
  constructor(deps = {}) {
    Object.assign(this, deps);
  }

  async run() {
    const {
      maybeAnnounceAutoMergeSetting,
      listJobs,
      jobsNeedGitWorktree,
      processIterativeWrapUp,
      mergeIterativePassToTarget,
      listWorkItems,
      isReviewableWorkItem,
      cmdReview,
      C,
      CONCURRENCY,
      getWorkItem,
      updateWorkItemStatus,
      ensureRepoSetupConfirmed,
      ensureGitReady,
      guardStartupDirtyTree,
      ensureBootDependenciesInWorker: runBootDependencySync = ensureBootDependenciesInWorker,
      formatBootDependencySync: formatBootDependencySyncForRun = formatBootDependencySync,
      NO_TUI,
      Scheduler,
      primeProviderUsageAuth,
      primeProviderUsageAuthAsync,
      getProviderHealth,
      PROJECT_DIR,
      checkRemotePromptBundleReadiness,
      checkRemotePromptCompilerReadiness,
      getConfiguredProviderUsageAsync,
      PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS: providerUsageWarmupSoftTimeoutMs = PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS,
      PROVIDER_AUTH_WARMUP_TIMEOUT_MS: providerAuthWarmupTimeoutMs = PROVIDER_AUTH_WARMUP_TIMEOUT_MS,
      startupWorktreeCleanup,
      ensureAtlasCommitReindexHook,
      getAtlasIntegrationConfig,
      ensureAtlasRepoIndexedOnBoot,
      prewarmAtlasV2BootDeps,
      inspectLocalOnnxStatus: inspectLocalOnnxStatusForRun = inspectLocalOnnxStatus,
      ThreadManager: RunThreadManager = ThreadManager,
      disableAtlasForRun,
      log,
      Display,
      STALL_TIMEOUT,
      Worker,
      AUTO_APPROVE,
      DRY_RUN,
      requeueWaitingHumanInputJobs,
      refreshWorkItemStatus,
      inferWiMode,
      researchBudgetMetadata,
      createWorkItem,
      createInitialResearchOrPlanJob,
      shouldUseRedTeamPlanForWorkItem,
      classifyResearchForRouting,
      ensureArtifactDirs,
      wiScopeId,
      artifactsDir,
      getResolvedImageProtocol,
      createJob,
      getJob,
      getToolInvocationCountsByJob,
      getRecentToolInvocations,
      listActiveFileLocks,
      storeArtifact,
      logEvent,
      cancelWorkItemJobs,
      cleanupWiBranchAsync,
      skipJob,
      runLiveReview,
      collectDirtyStateAsync,
      defaultResearchModelTier = () => "strong",
      researchBudgetToReasoningEffort,
      researchPayload,
      autoMergeCompletedWorkItems,
      hasAutoMergeableCompletedWorkItems,
      autoMergePendingReviewBlockers,
      describePendingReviewLockBlockers,
      wrapUpTui,
      wrapUp,
      offerPush,
      exitProcess = process.exit,
    } = this;

  // Display is created after boot so that boot output lands on the real terminal,
  // not the alt-screen buffer. The onBeforeLoop closure captures `display` by
  // reference — it's null during boot, populated before runLoop().
  const useTui = !NO_TUI && process.stdout.isTTY;
  let display = null;
  try { resetOnnxWarmState(); } catch { /* warm chip state is observational */ }
  // Captured when the ATLAS warmup kicks so boot can WAIT for the (off-thread)
  // index build to finish before workers start — the index must be current
  // pre-loop, not built in the background while jobs run.
  let atlasWarmCompletion = null;
  let resolveAtlasBootBackgroundRequest = null;
  let atlasBootBackgroundRequested = false;
  let atlasBootBackgroundReason = null;
  const atlasBootBackgroundRequest = new Promise((resolve) => {
    resolveAtlasBootBackgroundRequest = resolve;
  });
  // Deferred starter for the ATLAS/SCIP indexing phase. Assigned where the boot
  // warmups are assembled, invoked AFTER scheduler.boot so the upper boot
  // section (checklist + providers + lock/orphan/pre-loop) finishes before
  // indexing begins. Declared at function scope so the post-boot call site can
  // reach it regardless of the assembly block.
  let startAtlasWarmupPhase = null;
  let displaySnapshotCaches = null;
  const displaySnapshotTimers = new Set();
  const trackDisplaySnapshotTimer = (timer) => {
    if (!timer) return timer;
    timer.unref?.();
    displaySnapshotTimers.add(timer);
    return timer;
  };
  const clearDisplaySnapshotTimers = () => {
    for (const timer of displaySnapshotTimers) clearInterval(timer);
    displaySnapshotTimers.clear();
  };
  const stopDisplaySnapshotCaches = () => {
    clearDisplaySnapshotTimers();
    displaySnapshotCaches?.dirty?.stop?.();
    displaySnapshotCaches?.pipeline?.stop?.();
    displaySnapshotCaches?.tools?.stop?.();
    displaySnapshotCaches = null;
  };
  const refreshDisplaySnapshotsForQueue = () => {
    if (!displaySnapshotCaches) return;
    void displaySnapshotCaches.dirty.refresh();
    if (display?._rightMode === "pipeline") void displaySnapshotCaches.pipeline.refresh();
    if (display?._rightMode === "tools") void displaySnapshotCaches.tools.refresh();
  };
  const setupDisplaySnapshotCaches = () => {
    if (!display || displaySnapshotCaches) return;
    const snapshotArgs = {
      projectDir: PROJECT_DIR,
      dbPath: getRuntimeDbPath(PROJECT_DIR),
    };
    const requestPaneRender = (mode) => {
      if (display?._rightMode === mode) display.requestRender?.({ reason: "queue-snapshot" });
    };
    const buildLocalToolSnapshot = () => {
      const fallback = EMPTY_TOOL_SNAPSHOT;
      const snapshot = { jobs: [], recent: [], activeLocks: fallback.activeLocks };
      if (typeof getToolInvocationCountsByJob === "function") {
        try { snapshot.jobs = getToolInvocationCountsByJob({ limit: 20 }); }
        catch (err) { log?.debug?.("display", "Local tool job-count fallback failed", { error: String(err?.message || err) }); }
      }
      if (typeof getRecentToolInvocations === "function") {
        try { snapshot.recent = getRecentToolInvocations({ limit: 40 }); }
        catch (err) { log?.debug?.("display", "Local recent-tool fallback failed", { error: String(err?.message || err) }); }
      }
      if (typeof listActiveFileLocks === "function") {
        try { snapshot.activeLocks = listActiveFileLocks(); }
        catch (err) { log?.debug?.("display", "Local active-lock fallback failed", { error: String(err?.message || err) }); }
      }
      return snapshot;
    };
    const loadToolSnapshot = async () => {
      try {
        const snapshot = await runTuiSnapshotTask("tools", snapshotArgs);
        if (snapshot?.activeLocks) return snapshot;
        const local = buildLocalToolSnapshot();
        return { ...local, ...(snapshot || {}), activeLocks: local.activeLocks };
      } catch (err) {
        log?.debug?.("display", "Tool snapshot worker failed; using local fallback", { error: String(err?.message || err) });
        return buildLocalToolSnapshot();
      }
    };
    const dirty = createAsyncSnapshotCache({
      initialValue: null,
      minIntervalMs: 2500,
      load: typeof collectDirtyStateAsync === "function" ? () => collectDirtyStateAsync() : null,
      onUpdate: (state) => display?.acceptDirtyStateSnapshot?.(state),
      onError: (err) => {
        log?.debug?.("display", "Dirty-state snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    const pipeline = createAsyncSnapshotCache({
      initialValue: [],
      minIntervalMs: 750,
      load: () => runTuiSnapshotTask("pipeline", snapshotArgs),
      onUpdate: () => requestPaneRender("pipeline"),
      onError: (err) => {
        log?.debug?.("display", "Pipeline snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    const tools = createAsyncSnapshotCache({
      initialValue: buildLocalToolSnapshot(),
      minIntervalMs: 750,
      load: loadToolSnapshot,
      onUpdate: () => requestPaneRender("tools"),
      onError: (err) => {
        log?.debug?.("display", "Tool snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    displaySnapshotCaches = { dirty, pipeline, tools };
    display.getDirtyState = () => dirty.get();
    display.getPipelineData = () => pipeline.get();
    display.getToolData = () => tools.get();
    void dirty.refresh({ force: true });
    void pipeline.refresh({ force: true });
    void tools.refresh({ force: true });
    trackDisplaySnapshotTimer(setInterval(() => void dirty.refresh(), 5000));
    trackDisplaySnapshotTimer(setInterval(() => {
      if (display?._rightMode === "pipeline") void pipeline.refresh();
      if (display?._rightMode === "tools") void tools.refresh();
    }, 1000));
  };

  const hasLiveDisplay = () => !!(display && display._started !== false && typeof display.addEvent === "function");
  const emitCloseoutStatus = (message, color = C.dim) => {
    const line = `${color}${message}${C.reset}`;
    if (hasLiveDisplay()) {
      display.addEvent(line);
      display.requestRender?.({ force: true });
    } else {
      console.log(`  ${line}`);
    }
  };
  const flushCloseoutStatus = async () => {
    if (hasLiveDisplay()) await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const cleanupAtlasForSession = async ({ label = "Run wrap-up", announce = true } = {}) => {
    const displayStatus = announce && hasLiveDisplay();
    const startedAt = Date.now();
    if (announce) {
      if (displayStatus) {
        display.setRunPhase?.("ATLAS cleanup");
        display.setBlockingOverlay?.("ATLAS cleanup", "Closing ATLAS v2 resources.");
      }
      emitCloseoutStatus(`${label}: ATLAS cleanup...`, C.cyan);
      await flushCloseoutStatus();
    }
    // Release the keep-warm pin and dispose the shared conductor — terminates its
    // worker thread (its MessagePort pins the event loop on Node ≥22) so the
    // process can drain and exit instead of waiting out the idle backstop.
    try { setConductorKeepWarm(false); await closeSharedConductor(); } catch { /* best-effort */ }
    if (announce) {
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      emitCloseoutStatus(`${label}: ATLAS cleanup complete (${elapsedSec}s).`, C.green);
    }
    if (displayStatus) {
      display.setBlockingOverlay?.(null);
      display.setRunPhase?.(label);
    }
    if (announce) await flushCloseoutStatus();
  };

  let schedulerStopPromise = null;
  const scheduleSchedulerStop = () => {
    try { scheduler.requestStop?.(); } catch { /* best-effort */ }
    if (schedulerStopPromise) return schedulerStopPromise;
    schedulerStopPromise = new Promise((resolve) => {
      const finish = () => {
        try { scheduler.stop(); } catch { /* best-effort */ }
        resolve();
      };
      if (typeof setImmediate === "function") setImmediate(finish);
      else setTimeout(finish, 0);
    });
    return schedulerStopPromise;
  };

  maybeAnnounceAutoMergeSetting();
  const jobs = listJobs(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
  const needsGit = jobsNeedGitWorktree(jobs);

  if (jobs.length === 0) {
    const iterateResult = await processIterativeWrapUp({
      reason: "run start",
      mergeIterativePassToTarget,
    });
    if (iterateResult.rerun) {
      await this.run();
      return;
    }
    const autoMergedNow = await autoMergeCompletedWorkItems({ reason: "run start" });
    // No active jobs — but if there are reviewable work items, go straight to review
    const reviewable = listWorkItems(["complete", "failed"]).filter(isReviewableWorkItem);
    if (reviewable.length > 0) {
      console.log(`\n  ${C.bold}No active jobs — ${reviewable.length} work item(s) ready for review.${C.reset}\n`);
      await cmdReview();
      return;
    }
    if (autoMergedNow > 0) {
      await offerPush?.(autoMergedNow);
      return;
    }
    console.log(`\n  No active jobs. Use 'plan' to create jobs from queued items.\n`);
    return;
  }

  // ── Session-state detection ──
  // Categorise jobs to tell the user whether we're resuming or starting fresh.
  const resumed   = jobs.filter(j => j.status === "leased" || j.status === "running");
  const stallResume = jobs.filter(j => !!parseJobPayload(j)._stall_resume);
  const wiIds = new Set(jobs.map((j) => j.work_item_id));
  const wiWithBranch = [...wiIds].filter(id => { const wi = getWorkItem(id); return wi && wi.branch_name; });

  const isResume = resumed.length > 0 || stallResume.length > 0 || wiWithBranch.length > 0;

  if (isResume) {
    console.log(`\n  ${C.green}${C.bold}Resuming session${C.reset}${C.green}: ${jobs.length} active job(s) (concurrency: ${CONCURRENCY})${C.reset}`);
    if (wiWithBranch.length > 0)
      console.log(`  ${C.cyan}Rejoining ${wiWithBranch.length} worktree(s)${C.reset}`);
    if (stallResume.length > 0)
      console.log(`  ${C.yellow}${stallResume.length} job(s) will resume from stash${C.reset}`);
    if (resumed.length > 0)
      console.log(`  ${C.yellow}${resumed.length} previously in-flight job(s) requeued${C.reset}`);
    console.log();
  } else {
    console.log(`\n  ${C.bold}New session: ${jobs.length} active job(s) (concurrency: ${CONCURRENCY})${C.reset}\n`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Boot panel — single instance, spans the entire boot lifecycle from the
  // pre-scheduler readiness checks (repo setup, git ready, …) through the
  // scheduler boot phases (lock, orphan, pre-loop, workspace health,
  // provider auth liveness, complete) until display.start() attaches the
  // alt-screen TUI. Every Boot: log site routes through updateBootStep so
  // there's exactly one panel and no duplicated stdout lines.
  // ════════════════════════════════════════════════════════════════════════
  const bootAbortController = new AbortController();
  let bootMonitorTimer = null;
  let bootMonitorDisposed = false;
  let bootRenderedRows = 0;
  let bootLastRenderAt = 0;
  const bootSteps = new Map();
  const BOOT_RENDER_MIN_MS = 90;
  const BOOT_RENDER_GUTTER_COLUMNS = 3;
  const bootTerminalColumns = () => {
    const columns = Number(process.stdout?.columns);
    if (Number.isFinite(columns) && columns > 1) return Math.max(1, Math.floor(columns));
    return 120;
  };
  const bootRenderColumns = () => Math.max(1, bootTerminalColumns() - BOOT_RENDER_GUTTER_COLUMNS);
  // Mirror boot step state into runtime_status (throttled, trailing-edge)
  // so the bridge can stream instance_status boot progress to the phone.
  let bootStatusTimer = null;
  let bootStatusPending = null;
  const bootStartedAtIso = new Date().toISOString();
  const flushBootStatus = () => {
    bootStatusTimer = null;
    const steps = bootStatusPending;
    bootStatusPending = null;
    if (!steps) return;
    try {
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, {
        steps: steps.slice(0, 30).map((step) => ({
          ...step,
          label: String(step.label || "").slice(0, 120),
          ...(step.detail ? { detail: String(step.detail).slice(0, 200) } : {}),
        })),
        started_at: bootStartedAtIso,
      });
    } catch { /* status mirroring is best-effort */ }
  };
  const bootPanel = createBootPanel({
    C,
    columns: bootRenderColumns,
    onChange: (steps) => {
      bootStatusPending = steps;
      if (bootStatusTimer) return;
      bootStatusTimer = setTimeout(flushBootStatus, 500);
      bootStatusTimer.unref?.();
    },
  });
  // Stale rows from a previous crash must not masquerade as a live boot.
  try {
    clearRuntimeStatus(RUNTIME_STATUS_KEYS.SHUTDOWN);
    writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, { steps: [], started_at: bootStartedAtIso });
  } catch { /* best-effort */ }
  const STEP_SECTION_MAP = new Map([
    ["repo setup", "scheduler"],
    ["dependencies", "workspace"],
    ["startup work tree", "workspace"],
    ["git ready", "workspace"],
    ["worktree cleanup", "workspace"],
    ["lock acquired", "scheduler"],
    ["orphan recovery", "scheduler"],
    ["pre-loop hooks", "scheduler"],
    ["workspace health", "workspace"],
  ]);
  const shortBootText = (value, max = 34) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  };
  const bootMonitorRows = () => bootPanel.lines();
  const bootMonitorRowWidth = () => bootRenderColumns();
  const fitBootMonitorRow = (row) => fitAnsi(row, bootMonitorRowWidth(), { reset: C.reset }).trimEnd();
  // ── terminal output interception during boot ──────────────────────────
  // While the boot panel owns the terminal, ANY foreign TTY write (a subprocess
  // inheriting the parent's streams, a third-party lib's console.log/error, a
  // logger somewhere we don't control) would push the cursor below where the
  // panel "thinks" it is. The next cursor-up calculation is then off and a
  // fresh panel header stacks below the previous one.
  //
  // Solution: monkey-patch process stdout/stderr writes while they point at a
  // TTY. Panel renders use the intercept's saved stdout write directly
  // (bypass the patch).
  // Everything else gets buffered and replayed verbatim once the panel tears
  // down, so nothing is lost.
  const terminalOutputIntercept = createTerminalOutputIntercept({
    stdout: process.stdout,
    stderr: process.stderr,
  });

  const renderBootMonitor = ({ final = false, force = false } = {}) => {
    if (display || bootSteps.size === 0) return;
    if (bootMonitorDisposed && !final) return;
    // Skip rendering entirely under non-TTY (e.g. `node --test`, CI logs):
    // the visual panel would just garble structured runner output and the
    // intercept can't be installed safely without breaking IPC.
    if (!process.stdout.isTTY) return;
    const now = Date.now();
    if (!final && !force && bootRenderedRows > 0 && now - bootLastRenderAt < BOOT_RENDER_MIN_MS) return;
    terminalOutputIntercept.install();
    const rows = bootMonitorRows().map(fitBootMonitorRow);
    const rowsToWrite = Math.max(rows.length, bootRenderedRows || 1);
    let buf = "";
    if (bootRenderedRows > 0) {
      const up = bootRenderedRows - 1;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += "\r";
    }
    for (let i = 0; i < rowsToWrite; i += 1) {
      if (i > 0) buf += "\n";
      buf += `${rows[i] || ""}\x1b[K`;
    }
    if (final) buf += "\n";
    // Use the saved original write directly so this render bypasses the
    // intercept — panel rendering must always reach the terminal.
    terminalOutputIntercept.writeStdout(buf);
    bootRenderedRows = final ? 0 : rows.length;
    bootLastRenderAt = now;
  };
  const ensureBootMonitor = () => {
    if (display || bootMonitorTimer || bootMonitorDisposed) return;
    bootMonitorTimer = setInterval(() => renderBootMonitor({ force: true }), 120);
    bootMonitorTimer.unref?.();
  };
  const updateBootStep = (label, patch = {}) => {
    const { force = false, ...stepPatch } = patch;
    const previous = bootSteps.get(label) || { status: "running", detail: "", percent: null };
    // Step-start diagnostic — fires when a step first appears in "running"
    // state. Pairs with the existing "step complete"/"step failed" log lines
    // so a frozen boot leaves a fingerprint: the most recent "step started"
    // without a matching completion is the wedge.
    const wasPending = bootSteps.get(label)?.status === "pending";
    if ((!bootSteps.has(label) || wasPending) && (stepPatch.status === "running" || stepPatch.status == null)) {
      log?.info?.("run", "Boot step started", { label, section: stepPatch.section || STEP_SECTION_MAP.get(label) || "internal" });
    }
    bootSteps.set(label, { ...previous, ...stepPatch, updatedAt: Date.now() });
    const section = stepPatch.section || STEP_SECTION_MAP.get(label);
    if (section && section !== "internal") {
      // Surface a short "what it's doing right now" detail on the running step
      // so the checklist shows live activity instead of a bare spinner. The
      // panel is fixed-width and truncates, so streaming detail can't widen the
      // layout; we keep the running detail tighter (28) than the terminal one
      // (40) to leave room for it to sit beside the active label.
      const resolvedStatus = stepPatch.status || previous.status || "running";
      const terminalDetail = (stepPatch.showDetail || resolvedStatus === "failed") && resolvedStatus !== "running";
      const panelDetail = terminalDetail
        ? shortBootText(stepPatch.detail || "", 40)
        : resolvedStatus === "running"
          ? shortBootText(stepPatch.detail ?? previous.detail ?? "", 28)
          : "";
      bootPanel.updateStep(label, {
        status: stepPatch.status || previous.status || "running",
        detail: panelDetail,
        percent: stepPatch.percent ?? null,
        section,
      });
    }
    if (display) return;
    ensureBootMonitor();
    renderBootMonitor({
      force: force || bootRenderedRows === 0 || patch.status === "ok" || patch.status === "failed",
    });
  };
  const providerBootSteps = new Map();
  const normalizeProviderStepName = (value) => String(value || "").trim().toLowerCase();
  // The providers row reports *readiness of the providers a user picks*, not
  // per-capability variants or internal primes. `getProviderHealth()` tags
  // image-capable providers with a "-images" suffix after the fact
  // (grok → grok-images), so we fold that suffix back into the base name: the
  // user reads "grok" as "is Grok ready", and a provider configured *only* for
  // images must still surface under its real name rather than vanish. When a
  // base chip already exists, the suffixed capability row must not override it
  // (the base provider row is authoritative for "is this provider ready"); it
  // only creates the chip when nothing else has. "usage" isn't a provider, so
  // it never earns a chip.
  const updateProviderBootStep = (label, patch = {}) => {
    const rawName = normalizeProviderStepName(label);
    if (!rawName || rawName === "usage") return;
    const fromImageCapability = /-images?$/.test(rawName);
    const providerName = rawName.replace(/-images?$/, "");
    if (!providerName) return;
    // Capability rows annotate an already-known provider — don't let them
    // restate or downgrade the base chip; only let them seed a missing one.
    if (fromImageCapability && providerBootSteps.has(providerName)) return;
    const { force = false, ...stepPatch } = patch;
    const previous = providerBootSteps.get(providerName) || { status: "running", detail: "" };
    const next = {
      ...previous,
      ...stepPatch,
      section: "providers",
      detail: shortBootText(stepPatch.detail ?? previous.detail ?? "", 40),
    };
    providerBootSteps.set(providerName, next);
    // Match the scheduler/workspace rows: don't widen the panel with the
    // running "explanation" (OAuth/checking/…) detail — only surface detail on
    // terminal/failed states. Keep the full detail in `providerBootSteps` for
    // diagnostics and the text-monitor fallback.
    const showPanelDetail = next.status === "ok"
      || next.status === "failed"
      || next.status === "skipped"
      || next.status === "deferred";
    bootPanel.updateStep(providerName, { ...next, detail: showPanelDetail ? next.detail : "" });
    if (display) return;
    ensureBootMonitor();
    renderBootMonitor({
      force: force || next.status === "ok" || next.status === "failed" || next.status === "deferred",
    });
  };
  const providerStatusFromHealth = (status) => {
    const value = String(status || "").trim().toLowerCase();
    if (value === "available") return "ok";
    if (value === "unavailable") return "failed";
    return "deferred";
  };
  const finalizeRunningProviderBootSteps = (status, detail = "") => {
    for (const [providerName, step] of providerBootSteps.entries()) {
      if (step.status !== "running") continue;
      updateProviderBootStep(providerName, {
        status,
        detail,
        force: true,
      });
    }
  };
  const TERMINAL_BOOT_LANG_STATES = new Set(["done", "skipped", "deferred", "failed"]);
  // Languages the matrix is allowed to show — the set we actually index for
  // code intelligence: resolved SCIP plan source languages (e.g. ts + js from
  // scip-typescript, php) plus detected-but-no-binary candidates. Populated
  // during boot-matrix seeding below. ATLAS parses lots of incidental files
  // (shell, markup, config like sh) that have no SCIP indexer; those would only
  // ever read "parsed, never indexed", so we drop their rows. While the set is
  // empty (SCIP off / pre-seed), don't filter — otherwise the matrix is blank.
  const matrixLanguages = new Set();
  const updateBootLang = (language, side, patch = {}) => {
    const bootLanguageKey = String(language || "").trim().toLowerCase();
    if (!bootLanguageKey || (side !== "atlas" && side !== "scip")) return;
    if (matrixLanguages.size > 0 && !matrixLanguages.has(bootLanguageKey)) return;
    bootPanel.updateLang(bootLanguageKey, side, patch);
    refreshBootBanner();
    if (display) return;
    ensureBootMonitor();
    renderBootMonitor({ force: patch.state === "done" || patch.state === "failed" });
  };
  let bootFooterText = "";
  let bootEnterAction = null;
  let bootInputInstalled = false;
  let bootInputWasRaw = false;
  let bootInputHandler = null;
  const installBootInput = () => {
    if (bootInputInstalled) return;
    if (!process.stdin?.isTTY || !process.stdout?.isTTY) return;
    if (typeof process.stdin.setRawMode !== "function") return;
    try { readline.emitKeypressEvents(process.stdin); } catch { return; }
    bootInputWasRaw = !!process.stdin.isRaw;
    bootInputHandler = (str, key = {}) => {
      if (key?.ctrl && key?.name === "c") {
        process.emit("SIGINT");
        return;
      }
      if (key?.name === "return" || key?.name === "enter" || str === "\r" || str === "\n") {
        try { bootEnterAction?.(); } catch (err) {
          log?.warn?.("run", "Boot footer action failed", { error: firstLine(err?.message || err) });
        }
      }
    };
    try { process.stdin.setRawMode(true); } catch { return; }
    try { process.stdin.resume?.(); } catch { /* best effort */ }
    process.stdin.on("keypress", bootInputHandler);
    bootInputInstalled = true;
  };
  const releaseBootInput = () => {
    if (!bootInputInstalled) {
      bootEnterAction = null;
      return;
    }
    if (bootInputHandler) process.stdin.off("keypress", bootInputHandler);
    try { process.stdin.setRawMode(bootInputWasRaw); } catch { /* terminal may already be closed */ }
    try { process.stdin.pause?.(); } catch { /* best effort */ }
    bootInputInstalled = false;
    bootInputHandler = null;
    bootEnterAction = null;
  };
  const setBootEnterAction = (handler = null) => {
    bootEnterAction = typeof handler === "function" ? handler : null;
    if (bootEnterAction) installBootInput();
    else releaseBootInput();
  };
  const updateBootFooter = (text) => {
    const next = String(text || "").trim();
    if (next === bootFooterText) return;
    bootFooterText = next;
    bootPanel.setFooter(next);
    if (display) return;
    ensureBootMonitor();
    renderBootMonitor({ force: true });
  };
  const requestAtlasBootBackground = (reason = "user-enter") => {
    if (atlasBootBackgroundRequested) return;
    atlasBootBackgroundRequested = true;
    atlasBootBackgroundReason = reason;
    log?.info?.("atlas", "ATLAS boot wait released to background", { reason });
    updateBootFooter("ATLAS/ONNX loading in background; entering the TUI...");
    setBootEnterAction(null);
    try { resolveAtlasBootBackgroundRequest?.({ kind: "background", reason }); } catch { /* best effort */ }
  };
  // Banner progress tracking — three numbers that drive the negative-space
  // "NEURAL NETWORK" banner colour (grey -> blue -> green). atlas/scip aggregate
  // over per-language matrix entries; onnx flips on encoder warm completion.
  const bannerState = { atlasPercent: 0, scipPercent: 0, onnxPercent: 0 };
  const aggregatePanelProgress = () => {
    let atlasSum = 0, atlasCounted = 0, atlasTotal = 0;
    let scipSum = 0, scipCounted = 0, scipTotal = 0;
    for (const [, entry] of bootPanel.languageEntries()) {
      const sides = /** @type {[string, any][]} */ ([["atlas", entry?.atlas], ["scip", entry?.scip]]);
      for (const [name, side] of sides) {
        if (!side) continue;
        const isAtlas = name === "atlas";
        if (isAtlas) atlasTotal += 1; else scipTotal += 1;
        // Terminal no-progress states contribute to "everything's done"
        // arithmetic but don't count toward the running mean.
        if (side.state === "skipped" || side.state === "failed" || side.state === "deferred") continue;
        const percent = side.state === "done"
          ? 100
          : Number.isFinite(Number(side.percent)) ? Number(side.percent) : 0;
        if (isAtlas) { atlasSum += percent; atlasCounted += 1; }
        else { scipSum += percent; scipCounted += 1; }
      }
    }
    // No registered languages at all -> 0% (haven't started yet). All entries
    // skipped/disabled -> 100% (nothing to do, treat as done). Otherwise the
    // mean of the actively-tracked sides.
    bannerState.atlasPercent = atlasCounted > 0
      ? atlasSum / atlasCounted
      : (atlasTotal > 0 ? 100 : 0);
    bannerState.scipPercent = scipCounted > 0
      ? scipSum / scipCounted
      : (scipTotal > 0 ? 100 : 0);
  };
  // Update the banner footer without triggering a separate render — callers
  // already follow up with renderBootMonitor (or are inside a render path).
  // Throttled to ~100ms because per-language indexer events can fire many
  // times per second and re-rendering the banner allocates ~280 ANSI
  // sequences each pass — wasted work since the visible render is throttled
  // to ~90ms inside renderBootMonitor anyway.
  const BANNER_REFRESH_MIN_MS = 100;
  let lastBannerRefreshAt = 0;
  const refreshBootBanner = () => {
    const now = Date.now();
    if (now - lastBannerRefreshAt < BANNER_REFRESH_MIN_MS) return;
    lastBannerRefreshAt = now;
    aggregatePanelProgress();
    bootPanel.setFooter(renderNeuralNetworkBanner(bannerState));
  };
  // Initial paint so the banner appears in the footer slot from t=0, even
  // before the first per-language event lands.
  refreshBootBanner();
  const stopBootMonitor = ({ final = false } = {}) => {
    if (bootMonitorTimer) {
      clearInterval(bootMonitorTimer);
      bootMonitorTimer = null;
    }
    if (final) {
      if (bootMonitorDisposed) {
        terminalOutputIntercept.release();
        return;
      }
      releaseBootInput();
      renderBootMonitor({ final: true, force: true });
      bootMonitorDisposed = true;
      // Restore real process.stdout and replay anything that tried to write
      // while the panel was up (subprocess output, third-party logs, etc.)
      // — they appear as scrollback above where the TUI will attach.
      terminalOutputIntercept.release();
    }
  };
  const runWithBootTerminalPassthrough = async (fn) => {
    const shouldResumeTimer = !!bootMonitorTimer;
    if (bootMonitorTimer) {
      clearInterval(bootMonitorTimer);
      bootMonitorTimer = null;
    }
    releaseBootInput();

    const passthroughStartsWithPanel = bootRenderedRows > 0 && !!process.stdout?.isTTY;
    let passthroughWrote = false;
    const breakBeforePassthroughOutput = (writeNewline) => {
      if (!passthroughStartsWithPanel || passthroughWrote) return;
      passthroughWrote = true;
      try {
        // Clear the in-place boot panel before passthrough output begins, rather
        // than just pushing a newline. The old code left the panel orphaned above
        // the output while the `finally` re-rendered a fresh one below → two
        // identical "posse … boot · Ns" panels. Cursor → panel top, clear to end
        // of screen, so the output (and the re-rendered panel) take its place.
        const up = Math.max(0, bootRenderedRows - 1);
        writeNewline(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`);
      } catch { /* observational */ }
      bootRenderedRows = 0;
    };

    if (passthroughStartsWithPanel && terminalOutputIntercept.bufferedCount > 0) {
      breakBeforePassthroughOutput(terminalOutputIntercept.writeStdout);
    }
    terminalOutputIntercept.release();

    const restoreWrites = [];
    const installLazyBreak = (stream) => {
      if (!passthroughStartsWithPanel || !stream?.isTTY || typeof stream.write !== "function") return;
      const originalWrite = stream.write;
      stream.write = function passthroughWrite(...args) {
        breakBeforePassthroughOutput((text) => originalWrite.call(stream, text));
        return originalWrite.apply(stream, args);
      };
      restoreWrites.push(() => { stream.write = originalWrite; });
    };

    installLazyBreak(process.stdout);
    installLazyBreak(process.stderr);

    if (!passthroughStartsWithPanel && bootRenderedRows > 0) {
      terminalOutputIntercept.writeStdout("\n");
      bootRenderedRows = 0;
    }
    try {
      return await fn();
    } finally {
      for (let i = restoreWrites.length - 1; i >= 0; i -= 1) {
        try { restoreWrites[i](); } catch { /* observational */ }
      }
      if (!display && !bootMonitorDisposed) {
        bootLastRenderAt = 0;
        if (shouldResumeTimer) ensureBootMonitor();
        renderBootMonitor({ force: true });
      }
    }
  };
  const handleSchedulerBootEvent = (event = {}) => {
    if (!event.label) return;
    updateBootStep(event.label, {
      section: event.section,
      status: event.status,
      detail: event.detail || "",
      force: true,
    });
  };

  // ── track(): the universal boot/index task primitive ─────────────────────
  // Every unit of boot work flows through this so the boot panel is a pure
  // consumer of task lifecycle events: each task emits exactly one "start"
  // (spinner on) and settles EXACTLY once to a terminal event (✓/✗/⊘/deferred).
  // There is no fire-and-forget work and no detached continuation that mutates
  // the panel after settle — a hard timeout settles terminally and (optionally)
  // hands the still-pending promise off to the post-TUI app via `handoff`.
  //
  // CRITICAL: `fn` must already be truly async (off the main event loop — async
  // I/O / child process / worker thread). track() cannot un-block synchronous
  // work; a blocking fn would freeze the panel and stall lock renewal.
  /** @type {Array<Promise<any>>} promises handed off to run past TUI attach */
  const postTuiHandoffs = [];
  const bootTaskEmitter = (section, label) => (
    section === "providers"
      ? (patch) => updateProviderBootStep(label, patch)
      : (patch) => updateBootStep(label, { section, ...patch })
  );
  const track = (label, fn, {
    section = "internal",
    fatal = false,
    start = "working",
    done = () => "done",
    isOk = () => true,
    hardTimeoutMs = null,
    onHardTimeout = "deferred", // "deferred" | "failed" — terminal, NOT a detach
    handoff = null,             // (stillPending: Promise) => void
  } = {}) => {
    const startedAt = Date.now();
    const emit = bootTaskEmitter(section, label);
    log?.info?.("run", "Boot task start", { label, section, fatal, hardTimeoutMs });
    emit({ status: "running", detail: `${start}...`, startedAt });

    // No setImmediate "fake async" wrap — fn is expected to yield on its own.
    const runTask = Promise.resolve().then(fn);
    let timer = null;
    const raced = hardTimeoutMs && hardTimeoutMs > 0
      ? Promise.race([
        runTask.then((result) => ({ kind: "result", result }), (error) => ({ kind: "error", error })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), hardTimeoutMs);
          timer.unref?.();
        }),
      ])
      : runTask.then((result) => ({ kind: "result", result }), (error) => ({ kind: "error", error }));

    const settle = (status, detail, extra = {}) => {
      if (timer) clearTimeout(timer);
      emit({ status, detail });
      const durationMs = Date.now() - startedAt;
      log?.info?.("run", "Boot task settle", { label, status, duration_ms: durationMs, detail });
      const ok = status === "ok";
      if (!ok && fatal) {
        try { bootAbortController.abort(extra.error || new Error(`${label} ${status}`)); } catch { /* observational */ }
      }
      return { label, ok, fatal, status, ...extra };
    };

    return raced.then((outcome) => {
      if (outcome.kind === "timeout") {
        // Settle terminally now; hand the still-pending work off cleanly. The
        // continuation must NOT touch the panel after this point (logs only).
        if (typeof handoff === "function") { try { handoff(runTask); } catch { /* observational */ } }
        else runTask.catch(() => { /* swallow detached rejection */ });
        const status = onHardTimeout === "failed" ? "failed" : "deferred";
        return settle(status, `timed out after ${Math.round(hardTimeoutMs / 1000)}s`);
      }
      if (outcome.kind === "error") {
        const error = outcome.error;
        const errorId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        log?.warn?.("run", "Boot task failed", {
          errorId, label, fatal,
          error: String(error?.message || error || "unknown"),
          stack: error?.stack || null,
        });
        return settle("failed", `failed (${firstLine(error?.message || error)}; errorId=${errorId})`, { error });
      }
      const result = outcome.result;
      if (result && (result.__track === "skipped" || result.__track === "deferred")) {
        return settle(result.__track, result.detail || result.__track, { result });
      }
      const ok = isOk(result);
      return settle(ok ? "ok" : "failed", done(result, ok), { result });
    });
  };
  // settleAll: phase gate — wait for ALL tracked tasks to reach a terminal
  // state (Promise.allSettled semantics). track() never rejects, so this
  // returns the array of result objects; callers inspect for {fatal, ok:false}.
  const settleAll = (tasks) => Promise.all(tasks.map((p) => Promise.resolve(p)));
  bootAbortController.signal.addEventListener("abort", () => {
    try {
      for (const [label, step] of bootSteps.entries()) {
        if (step.status === "running") {
          updateBootStep(label, {
            status: "failed",
            detail: "aborted",
            showDetail: true,
            force: true,
          });
        }
      }
      stopBootMonitor({ final: true });
    } catch { /* observational */ }
  }, { once: true });

  // (No global process listeners — they leak across test fixtures. Every
  // boot exit path explicitly calls stopBootMonitor, which releases the
  // intercept. The TTY guard inside createTerminalOutputIntercept().install()
  // keeps it from firing under `node --test` anyway.)

  // ── Boot phase (panel-driven; alt-screen TUI takes over after display.start)
  // The TUI alt-screen buffer hides anything printed before display.stop(),
  // so all prompts, prerequisite checks, orphan recovery, provider health,
  // and ATLAS indexing run BEFORE we attach the display. Each phase routes
  // through updateBootStep so the boot panel shows a single coherent view
  // instead of a stream of `Boot: …` log lines.

  // Paint the full boot checklist up front — unstarted steps render as a dim
  // "-" (pending) so the sections are visible from the start and fill in as
  // each runs, instead of popping into view late as jobs start. Already-fired
  // steps keep their status (the guard skips them).
  for (const [stepLabel, stepSection] of STEP_SECTION_MAP) {
    if (!bootSteps.has(stepLabel)) {
      updateBootStep(stepLabel, { status: "pending", section: stepSection });
    }
  }

  // Pre-populate the per-language matrix with `waiting` rows so the user
  // sees from t=0 which languages will be indexed once Phase 1 (git +
  // cleanup + readiness) resolves. The filesystem scan inside
  // resolveScipStagePlans is fast (it walks the repo only deep enough to
  // detect the markers/extensions). Atlas can index any tree-sitter-supported
  // file; SCIP only fires for languages with both source files AND a
  // resolvable indexer binary.
  try {
    const atlasConfig = typeof getAtlasIntegrationConfig === "function"
      ? getAtlasIntegrationConfig()
      : null;
    const atlasDisabled = atlasConfig != null && atlasConfig.enabled === false;
    const scipDisabled = atlasDisabled
      || String(atlasConfig?.scipMode || "").trim().toLowerCase() === "off";
    const scipLookup = resolveScipStagePlans({
      repoRoot: PROJECT_DIR,
      languages: atlasConfig?.scipLanguages ?? atlasConfig?.atlas_scip_languages ?? null,
    });
    const seenLangs = new Set();
    for (const plan of scipLookup.plans || []) {
      const planLangs = Array.isArray(plan.sourceLanguages) && plan.sourceLanguages.length > 0
        ? plan.sourceLanguages
        : [plan.indexerId].filter(Boolean);
      for (const rawLang of planLangs) {
        const lang = String(rawLang || "").trim().toLowerCase();
        if (!lang) continue;
        seenLangs.add(lang);
        matrixLanguages.add(lang);
        updateBootLang(lang, "atlas", atlasDisabled
          ? { state: "skipped", detail: "disabled" }
          : { state: "waiting" });
        updateBootLang(lang, "scip", scipDisabled
          ? { state: "skipped", detail: "disabled" }
          : { state: "waiting" });
      }
    }
    // Languages where we know about the indexer (binary or source present)
    // but the indexer is unavailable — still show the row so the user knows
    // we tried, marked as ⊘ no source / ⊘ indexer missing.
    for (const candidate of scipLookup.candidates || []) {
      if (!candidate.resolved) {
        const candidateLangs = Array.isArray(candidate.sourceLanguages) && candidate.sourceLanguages.length > 0
          ? candidate.sourceLanguages
          : [candidate.id].filter(Boolean);
        for (const rawLang of candidateLangs) {
          const lang = String(rawLang || "").trim().toLowerCase();
          if (!lang || seenLangs.has(lang)) continue;
          seenLangs.add(lang);
          matrixLanguages.add(lang);
          updateBootLang(lang, "atlas", atlasDisabled
            ? { state: "skipped", detail: "disabled" }
            : { state: "waiting" });
          updateBootLang(lang, "scip", scipDisabled
            ? { state: "skipped", detail: "disabled" }
            : { state: "skipped", detail: `${candidate.command} not installed` });
        }
      }
    }
  } catch (err) {
    // Language detection failure is non-fatal — the matrix just stays empty
    // until ATLAS warmup populates it directly via per-language events.
    updateBootStep("language detection", {
      section: "internal",
      status: "failed",
      detail: err?.message || String(err),
    });
  }

  // ── Provider warmups (hoisted to top level) ──────────────────────────────
  // Render the provider chips and prime auth/usage RIGHT NOW instead of inside
  // onBeforeLoop (which runs after the pre-scheduler DAG + lock + orphan, so
  // these previously didn't render for seconds). They're non-fatal and
  // lock-independent, so it's safe to start them here. Each races its prime
  // against the soft-timeout: when the timer wins, the chip flips to
  // "background" and boot proceeds while the prime continues detached (the
  // prime's own timeoutMs bounds it). The fatal remote-prompt warmups stay in
  // onBeforeLoop so their failure still aborts boot + releases the lock.
  const providerWarmups = [];
  if (typeof getProviderHealth === "function") {
    try {
      for (const row of getProviderHealth() || []) {
        const providerName = normalizeProviderStepName(row?.provider || row?.name);
        // "-images" capability rows are folded into the base provider chip by
        // updateProviderBootStep; role rows come first, so they win.
        updateProviderBootStep(providerName, {
          status: providerStatusFromHealth(row?.status),
          detail: row?.detail || "",
          force: true,
        });
      }
    } catch (err) {
      log?.warn?.("run", "Provider boot health check failed", { error: firstLine(err?.message || err) });
    }
  }
  {
    // Each warmup races its (internally-bounded) prime against a soft-timeout:
    // the timeout is the no-wedge safety so a hung prime can't block boot
    // forever. The soft-timeout window is sized to the auth prime's own bound
    // (PROVIDER_AUTH_WARMUP_TIMEOUT_MS) so a NORMAL OAuth warm resolves the
    // chip to its real ✓/✗ BEFORE the window elapses — no premature "/ deferred"
    // flicker (the old 1.2s window flipped claude to deferred while the warm was
    // still running, and the panel could finalize before the real result landed).
    const softDeferProvider = (ms, onDefer) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { onDefer(); } catch { /* observational */ }
        resolve();
      }, Math.max(0, Number(ms) || 0));
      timer.unref?.();
    });
    // Prefer the async prime; fall back to the sync one (guarded so test
    // harnesses that inject only one — or neither — don't throw).
    const primeAuthFn = typeof primeProviderUsageAuthAsync === "function"
      ? primeProviderUsageAuthAsync
      : (typeof primeProviderUsageAuth === "function"
        ? async (opts) => primeProviderUsageAuth(opts)
        : null);
    const usageFn = typeof getConfiguredProviderUsageAsync === "function"
      ? getConfiguredProviderUsageAsync
      : null;
    if (providerBootSteps.has("claude")) {
      updateProviderBootStep("claude", { status: "running", detail: "OAuth", force: true });
    }
    providerWarmups.push(Promise.race([
      (async () => {
        const result = primeAuthFn
          ? await primeAuthFn({
            cwd: PROJECT_DIR,
            timeoutMs: providerAuthWarmupTimeoutMs,
          }).catch(() => null)
          : null;
        for (const row of (result?.providers || [])) {
          const providerName = String(row?.provider || row?.name || "").trim().toLowerCase();
          if (!providerName) continue;
          const status = row?.ok ? "ok" : (row?.retryable || row?.deferred) ? "deferred" : "failed";
          const detail = firstLine(row?.detail || row?.error || row?.stderr || row?.stdout || row?.skipped || "");
          updateProviderBootStep(providerName, { status, detail: detail === "unknown" ? "" : detail, force: true });
        }
      })(),
      // Auth soft-timeout window = the prime's own internal bound, so a normal
      // OAuth warm (which finishes in a couple seconds) resolves the chip to its
      // real ✓/✗ before this fires; only a genuinely wedged warm flips to
      // "deferred" (and that's the no-wedge backstop, not the common case).
      softDeferProvider(providerAuthWarmupTimeoutMs, () => finalizeRunningProviderBootSteps("deferred", "auth background")),
    ]));
    // Warm the usage cache in the background. Usage isn't a provider the user
    // selects, so it gets no readiness chip — failures stay in the logs and the
    // usage view rather than tossing a "usage" entry into the providers row.
    // The soft-timeout still keeps boot from blocking on a slow prime.
    providerWarmups.push(Promise.race([
      (async () => {
        if (!usageFn) return;
        await usageFn({
          cwd: PROJECT_DIR,
          timeoutMs: 5_000,
          onError: (providerName, err) => log?.warn?.("run", "Provider usage warmup error", { provider: providerName, error: firstLine(err?.message || err) }),
        }).catch((err) => { log?.warn?.("run", "Provider usage warmup failed", { error: firstLine(err?.message || err) }); });
      })(),
      softDeferProvider(providerUsageWarmupSoftTimeoutMs, () => {}),
    ]));
  }

  // ── Pre-scheduler DAG chain ───────────────────────────────────────────────
  // Order matches the boot DAG: repo setup → git ready → dirty tree guard →
  // worktree cleanup. The real session factory routes the dirty-tree guard
  // through the git workflow worker so slow Windows status scans cannot freeze
  // the boot renderer. Worktree cleanup still gates scheduler boot because
  // orphan recovery must requeue onto validated worktree state.
  updateBootStep("repo setup", { section: "scheduler", status: "running", force: true });
  if (!(await runWithBootTerminalPassthrough(() => ensureRepoSetupConfirmed()))) {
    updateBootStep("repo setup", { section: "scheduler", status: "failed", detail: "user declined", showDetail: true, force: true });
    return;
  }
  updateBootStep("repo setup", { section: "scheduler", status: "ok", force: true });

  updateBootStep("dependencies", { section: "workspace", status: "running", detail: "checking packages", force: true });
  try {
    const dependencyConfig = typeof getAtlasIntegrationConfig === "function"
      ? getAtlasIntegrationConfig()
      : null;
    const dependencyResult = await runBootDependencySync({
      projectDir: PROJECT_DIR,
      scipMode: dependencyConfig?.enabled === false
        ? "off"
        : (dependencyConfig?.scipMode ?? dependencyConfig?.atlas_scip_mode ?? null),
      scipLanguages: dependencyConfig?.scipLanguages ?? dependencyConfig?.atlas_scip_languages ?? null,
    }, {
      signal: bootAbortController.signal,
      onProgress: (event = {}) => {
        const msg = firstLine(event.message || "");
        if (!msg) return;
        updateBootStep("dependencies", {
          section: "workspace",
          status: "running",
          detail: msg,
          showDetail: true,
          force: true,
        });
      },
    });
    updateBootStep("dependencies", {
      section: "workspace",
      status: dependencyResult.ok ? "ok" : "failed",
      detail: formatBootDependencySyncForRun(dependencyResult),
      showDetail: !dependencyResult.ok,
      force: true,
    });
    if (!dependencyResult.ok) {
      // Boot already attempted the repair itself (dependency sync runs in
      // install mode); a failure here means a needed dependency could not be
      // installed automatically. Point at doctor, which reruns the same
      // repair with unbounded timeouts and a full per-dependency report.
      throw new Error(`Boot dependency sync failed: ${formatBootDependencySyncForRun(dependencyResult)} — run "posse doctor" to repair`);
    }
  } catch (err) {
    updateBootStep("dependencies", {
      section: "workspace",
      status: "failed",
      detail: err?.message || String(err),
      showDetail: true,
      force: true,
    });
    try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    throw err;
  }

  // Git Ready comes BEFORE Dirty Tree Guard because guardStartupDirtyTree
  // runs git commands; if git isn't available we want a clean error on the
  // git row, not a cryptic crash in the dirty-tree guard.
  // Posse is git-based, so verify git is usable on EVERY boot — not only when a
  // queued job needs a worktree. (The dirty-tree guard below already runs git
  // commands unconditionally, so gating the availability check on needsGit was
  // inconsistent.) A failure is fatal when a worktree job is queued (needsGit);
  // otherwise it degrades to skipped so a research-only / non-git session still
  // boots instead of aborting.
  {
    updateBootStep("git ready", { section: "workspace", status: "running", force: true });
    try {
      await ensureGitReady();
      updateBootStep("git ready", { section: "workspace", status: "ok", force: true });
    } catch (err) {
      if (needsGit) {
        updateBootStep("git ready", {
          section: "workspace",
          status: "failed",
          detail: err?.message || String(err),
          showDetail: true,
          force: true,
        });
        try { stopBootMonitor({ final: true }); } catch { /* observational */ }
        throw err;
      }
      updateBootStep("git ready", {
        section: "workspace",
        status: "skipped",
        detail: firstLine(err?.message || "git unavailable"),
        showDetail: true,
        force: true,
      });
    }
  }

  if (typeof guardStartupDirtyTree === "function") {
    updateBootStep("startup work tree", { section: "workspace", status: "running", force: true });
    try {
      await Promise.resolve(guardStartupDirtyTree({
        reason: "run start",
        onPhase: (event = {}) => {
          if (event.detail) {
            updateBootStep("startup work tree", {
              section: "workspace",
              status: "running",
              detail: event.detail,
              showDetail: true,
              force: true,
            });
          }
        },
      }));
      updateBootStep("startup work tree", { section: "workspace", status: "ok", force: true });
    } catch (err) {
      updateBootStep("startup work tree", {
        section: "workspace",
        status: "failed",
        detail: err?.message || String(err),
        showDetail: true,
        force: true,
      });
      // Tear the panel down + release the stdout intercept so the error
      // propagates cleanly without leaving the next test fixture stuck on a
      // hijacked process.stdout.write.
      try { stopBootMonitor({ final: true }); } catch { /* observational */ }
      throw err;
    }
  }

  // Worktree cleanup — pulled out of bootWarmups so it runs in DAG order
  // (after dirty tree guard, before scheduler.boot). This guarantees orphan
  // recovery sees a sane worktree state and per-language indexers don't try
  // to index stale `.posse-worktrees/wi-N` directories from dead processes.
  // Always prune stale worktrees on boot: leftover `.posse-worktrees/wi-N` dirs
  // from dead processes should be cleaned regardless of whether the current
  // queue needs a new worktree (a research-only session can still have stale
  // worktrees from a prior dev session). Fatal only when a worktree job is
  // queued; otherwise degrade to skipped.
  if (typeof startupWorktreeCleanup === "function") {
    updateBootStep("worktree cleanup", { section: "workspace", status: "running", force: true });
    try {
      await startupWorktreeCleanup({
        signal: bootAbortController.signal,
        skipDirtyTreeGuard: true,
        onMsg: (msg) => updateBootStep("worktree cleanup", {
          section: "workspace",
          status: "running",
          detail: firstLine(msg),
          showDetail: true,
          force: true,
        }),
      });
      updateBootStep("worktree cleanup", { section: "workspace", status: "ok", force: true });
    } catch (err) {
      if (needsGit) {
        updateBootStep("worktree cleanup", {
          section: "workspace",
          status: "failed",
          detail: err?.message || String(err),
          showDetail: true,
          force: true,
        });
        try { stopBootMonitor({ final: true }); } catch { /* observational */ }
        throw err;
      }
      updateBootStep("worktree cleanup", {
        section: "workspace",
        status: "skipped",
        detail: firstLine(err?.message || "cleanup skipped"),
        showDetail: true,
        force: true,
      });
    }
  }

  for (const wiId of wiIds) {
    const wi = getWorkItem(wiId);
    if (wi && ["planned", "planning"].includes(wi.status)) {
      updateWorkItemStatus(wiId, "running");
    }
  }

  // Forward the scheduler's queue snapshots into the display so renders
  // never have to re-query the DB. The display is created later (after
  // boot warmups), so we stash the latest snapshot here and replay it
  // once the display attaches.
  let pendingQueueSnapshot = null;
  const handleQueueSnapshot = (snapshot) => {
    pendingQueueSnapshot = snapshot;
    if (display && typeof display.acceptQueueSnapshot === "function") {
      const accepted = display.acceptQueueSnapshot(snapshot);
      if (accepted !== false) refreshDisplaySnapshotsForQueue();
    }
  };
  const scheduler = new Scheduler({
    concurrency: CONCURRENCY,
    hasDisplay: useTui,
    onQueueSnapshot: handleQueueSnapshot,
  });

  // During boot, scheduler events are already represented by the boot panel.
  // Once display attaches, route scheduler messages into the TUI event log.
  // In non-TTY/headless runs there is no panel, so keep stdout diagnostics.
  scheduler.onEvent = (msg, color = "yellow") => {
    if (display) {
      display.addEvent(`${C[color] || ""}[scheduler] ${msg}${C.reset}`);
      return;
    }
    if (useTui && process.stdout.isTTY) return;
    console.log(`  ${C[color] || ""}[scheduler] ${msg}${C.reset}`);
  };
  let lastPendingReviewBlockerMsg = null;
  let idleAutoMergePromise = null;
  const pendingReviewAutoMergeAttempts = new Set();

  const startIdleAutoMerge = ({
    reason = "scheduler idle",
    runGc = false,
    beforeStart = null,
    afterMerged = null,
    afterNoMerge = null,
    onError = null,
  } = {}) => {
    if (!autoMergePendingReviewBlockers || typeof autoMergeCompletedWorkItems !== "function") return false;
    if (idleAutoMergePromise) return false;
    try { beforeStart?.(); } catch { /* display/log callback only */ }
    idleAutoMergePromise = Promise.resolve()
      .then(() => autoMergeCompletedWorkItems({ display, reason, runGc }))
      .then((mergedCount) => {
        if (mergedCount > 0) afterMerged?.(mergedCount);
        else afterNoMerge?.();
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
        else {
          const errMsg = `Auto-merge during scheduler idle failed: ${err?.message || err}`;
          if (display) display.addEvent(`${C.red}${errMsg}${C.reset}`);
          else console.log(`\n  ${C.red}${errMsg}${C.reset}`);
        }
      })
      .finally(() => {
        idleAutoMergePromise = null;
      });
    return true;
  };

  const waitForIdleAutoMerge = async () => {
    const pending = idleAutoMergePromise;
    if (!pending) return;
    if (display && typeof display.setRunPhase === "function") {
      display.setRunPhase("Finishing pending auto-merge");
    } else if (!display && !useTui) {
      console.log(`\n  ${C.cyan}Finishing pending auto-merge before wrap-up...${C.reset}`);
    }
    await pending;
  };

  // Pre-loop hook runs during scheduler.boot() — display is still null at that
  // point so all output routes to console.log (plain stdout, pre-TUI). The
  // panel + render helpers live in outer run-session scope (above) so they
  // span the entire boot lifecycle, not just pre-loop. This closure only
  // owns warmup-specific render state.
  function firstLine(value) {
    return String(value || "unknown").trim().split(/\r?\n/)[0] || "unknown";
  }

  let bootAbortReason = null;
  const onBeforeLoop = async () => {
    let bootAtlasProgress = null;
    let bootScipProgress = null;
    let lastAtlasBootActivityEventKey = null;
    let lastScipBootActivityEventKey = null;
    const parseAtlasProgressPercent = (value) => {
      const text = String(value || "");
      const percentMatch = text.match(/(?:^|[^\d])(\d{1,3})(?:\.\d+)?\s*%/);
      if (percentMatch) {
        return Math.max(0, Math.min(100, Number(percentMatch[1])));
      }
      const ratioMatch = text.match(/(?:^|[^\d])(\d{1,7})\s*(?:\/|of)\s*(\d{1,7})(?:$|[^\d])/i);
      if (ratioMatch) {
        const current = Number(ratioMatch[1]);
        const total = Number(ratioMatch[2]);
        if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
          return Math.max(0, Math.min(100, (current / total) * 100));
        }
      }
      return null;
    };
    const atlasProgressPercentFromEvent = (event = {}) => {
      const direct = Number(event.percent ?? event.progress_percent);
      if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
      const current = Number(event.current ?? event.progress_current);
      const total = Number(event.total ?? event.progress_total);
      if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
        return Math.max(0, Math.min(100, (current / total) * 100));
      }
      return null;
    };
    const bootWarmup = (label, task, {
      fatal = false,
      start = "warming up",
      done = () => "warm",
      isOk = () => true,
      softTimeoutMs = null,
      softTimeoutDetail = "continuing in background",
      onSoftTimeout = null,
      // Chip status at soft-timeout. "ok" (default) suits steps whose tail is
      // genuinely fire-and-forget. Steps that still GATE boot after the
      // soft-timeout (the ATLAS warm — the pre-TUI gate keeps waiting on the
      // real task) must pass "running" so the hero gauge can't read 100%/ready
      // while boot is in fact still blocked on them.
      softTimeoutStatus = "ok",
    } = {}) => {
      const startedAt = Date.now();
      // Step-start diagnostic — pairs with "Boot readiness step complete" /
      // "soft-timeout" entries so a frozen boot can be fingerprinted from the
      // log: whichever start has no completion is the wedge.
      log?.info?.("run", "Boot readiness step start", { label, fatal, softTimeoutMs });
      updateBootStep(label, {
        status: "running",
        detail: `${start}...`,
        startedAt,
      });
      const runTask = new Promise((resolve) => setImmediate(resolve)).then(task);
      const requestedSoftTimeoutMs = Math.max(0, Number(softTimeoutMs) || 0);
      const effectiveSoftTimeoutMs = fatal ? 0 : requestedSoftTimeoutMs;
      const work = effectiveSoftTimeoutMs > 0
        ? (() => {
            let softTimeoutTimer = null;
            return Promise.race([
              runTask.then(
                (result) => ({ kind: "result", result }),
                (error) => ({ kind: "error", error }),
              ),
              new Promise((resolve) => {
                softTimeoutTimer = setTimeout(() => resolve({ kind: "soft-timeout" }), effectiveSoftTimeoutMs);
              }),
            ]).then((outcome) => {
              if (softTimeoutTimer) clearTimeout(softTimeoutTimer);
              if (outcome.kind === "soft-timeout") {
                runTask.catch(() => {});
                return {
                  __bootSoftTimeout: true,
                  detail: typeof softTimeoutDetail === "function" ? softTimeoutDetail() : softTimeoutDetail,
                };
              }
              if (outcome.kind === "error") throw outcome.error;
              return outcome.result;
            });
          })()
        : runTask;
      return work
        .then((result) => {
          const durationMs = Date.now() - startedAt;
          if (result?.__bootSoftTimeout) {
            try {
              onSoftTimeout?.(result);
            } catch (err) {
              log?.warn?.("run", "Boot warmup soft-timeout hook failed", {
                label,
                error: firstLine(err?.message || err),
              });
            }
            updateBootStep(label, {
              status: softTimeoutStatus,
              detail: result.detail || "continuing in background",
            });
            if (softTimeoutStatus === "running") {
              // The step stays in-flight on the panel, so flip it to its true
              // terminal state when the real task settles — otherwise the chip
              // spins forever and the gauge never reaches an honest 100%.
              // (An Enter-to-background can mark the step "deferred" first;
              // this late settle then upgrades it to the real outcome.)
              runTask.then(
                (taskResult) => {
                  const ok = isOk(taskResult);
                  const detail = done(taskResult, ok);
                  updateBootStep(label, { status: ok ? "ok" : "failed", detail, force: true });
                  log?.info?.("run", "Boot readiness step complete", {
                    label,
                    ok,
                    duration_ms: Date.now() - startedAt,
                    detail,
                    after_soft_timeout: true,
                  });
                },
                (error) => {
                  updateBootStep(label, {
                    status: "failed",
                    detail: `failed (${firstLine(error?.message || error)})`,
                    force: true,
                  });
                  log?.warn?.("run", "Boot warmup failed after soft-timeout", {
                    label,
                    error: String(error?.message || error || "unknown"),
                  });
                },
              );
            }
            log?.info?.("run", "Boot readiness step soft-timeout", {
              label,
              duration_ms: durationMs,
              detail: result.detail || "continuing in background",
            });
            return { label, ok: true, fatal, result, softTimedOut: true };
          }
          const ok = isOk(result);
          const detail = done(result, ok);
          updateBootStep(label, {
            status: ok ? "ok" : "failed",
            detail,
          });
          log?.info?.("run", "Boot readiness step complete", {
            label,
            ok,
            duration_ms: durationMs,
            detail,
          });
          return { label, ok, fatal, result };
        })
        .catch((error) => {
          const durationMs = Date.now() - startedAt;
          const errorId = `boot-warmup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          log?.warn?.("run", "Boot warmup failed", {
            errorId,
            label,
            fatal,
            duration_ms: durationMs,
            error: String(error?.message || error || "unknown"),
            stack: error?.stack || null,
          });
          const detail = `failed (${firstLine(error?.message || error)}; errorId=${errorId})`;
          updateBootStep(label, {
            status: "failed",
            detail,
          });
          return { label, ok: false, fatal, error };
        });
    };

    // A push-offer gate from the previous run is about to go stale (this
    // run will merge more work and re-offer at wrap-up). Supersede it now —
    // also prevents the scheduler loop from idling on a waiting_on_human
    // job nobody at this terminal can answer.
    try {
      const canceledPushGates = cancelOpenPushOfferGates("superseded_by_new_run");
      if (canceledPushGates > 0) {
        log?.info?.("run", "Superseded stale push-offer gate(s) at boot", { canceled: canceledPushGates });
      }
    } catch { /* best-effort */ }

    const bootWarmups = [];
    const remotePromptBundleWarmupLabel = "Remote prompt bundle";
    const remotePromptWarmupLabel = "Remote prompt compiler";
    const startupWorktreeCleanupLabel = "Startup worktree cleanup";

    if (typeof checkRemotePromptBundleReadiness === "function") {
      bootWarmups.push(bootWarmup(remotePromptBundleWarmupLabel, () => checkRemotePromptBundleReadiness(), {
        fatal: true,
        start: "fetching",
        done: (result = {}) => result.promptVersion
          ? `ready (${result.promptVersion}; ${result.skills || 0} skills)`
          : "ready",
        isOk: (result = {}) => result.ok !== false,
      }));
    }

    if (typeof checkRemotePromptCompilerReadiness === "function") {
      bootWarmups.push(bootWarmup(remotePromptWarmupLabel, () => checkRemotePromptCompilerReadiness({
        cwd: PROJECT_DIR,
      }), {
        fatal: true,
        start: "checking",
        done: (result = {}) => result.promptVersion
          ? `ready (${result.promptVersion})`
          : "ready",
        isOk: (result = {}) => result.ok !== false,
      }));
    }

    // Remote model catalog: refresh when stale (TTL-gated), then validate the
    // configured model settings against the merged catalog. Non-fatal — when
    // remote is unreachable the cached catalog (or builtin lists) keep working.
    bootWarmups.push(bootWarmup("Model catalog", async () => {
      await ensureRemoteCatalogLoaded();
      let refresh = null;
      try {
        refresh = await maybeRefreshModelCatalog();
      } catch { /* never fatal */ }
      const catalog = getRemoteCatalog();
      const warnings = validateConfiguredModels();
      for (const warning of warnings) {
        log?.warn?.("run", "Model catalog stale setting", {
          setting: warning.key,
          configured: warning.configured,
          status: warning.status,
          fallback: warning.fallback,
          detail: describeModelCatalogWarning(warning),
        });
      }
      const modelCount = catalog
        ? Object.values(catalog.providers).reduce((sum, entry) => sum + entry.textModels.length + entry.imageModels.length, 0)
        : 0;
      return {
        catalogVersion: catalog?.catalogVersion || null,
        modelCount,
        warnings,
        refreshed: refresh?.attempted === true && refresh?.ok === true,
      };
    }, {
      start: "fetching",
      softTimeoutMs: 4_000,
      softTimeoutDetail: "refreshing in background",
      done: (result = {}) => {
        const staleSuffix = result.warnings?.length
          ? `; ${result.warnings.length} stale model setting(s)`
          : "";
        if (!result.catalogVersion) return `builtin only${staleSuffix}`;
        const freshness = result.refreshed ? "" : " (cached)";
        return `${result.catalogVersion}${freshness} — ${result.modelCount} models${staleSuffix}`;
      },
      isOk: () => true,
    }));

    if (typeof prewarmAtlasV2BootDeps === "function") {
      bootWarmups.push(bootWarmup("ATLAS native prewarm", async () => {
        try {
          return await prewarmAtlasV2BootDeps();
        } catch (err) {
          return { ok: false, skipped: "prewarm_failed", error: err };
        }
      }, {
        start: "loading native modules",
        done: (result = {}) => result.ok === false
          ? `skipped (${firstLine(result.error?.message || result.error || "unknown")})`
          : "warm",
        isOk: () => true,
        softTimeoutMs: 2_500,
        softTimeoutDetail: "deferred (native module prewarm)",
      }));
    }

    // ── ONNX status (no eager warm here) ──────────────────────────────────
    // The encoder pipeline init in @huggingface/transformers parses the ONNX
    // model on the calling thread and blocks the event loop for many seconds.
    // Running it inline during boot freezes the boot panel/TUI and stalls the
    // scheduler heartbeat — the indexers visibly hang at 0%.
    //
    // Defer the warm until after both SCIP and ATLAS greenlight (i.e. all
    // bootWarmups settle, which is when the ATLAS warmup — which covers both
    // SCIP staging and ATLAS indexing — has resolved), and run it in a
    // worker thread so the parse never lands on the main loop.
    let onnxStatusAtBoot = null;
    try {
      const onnxConfig = typeof getAtlasIntegrationConfig === "function"
        ? getAtlasIntegrationConfig()
        : null;
      onnxStatusAtBoot = inspectLocalOnnxStatusForRun({
        repoRoot: PROJECT_DIR,
        config: onnxConfig || {},
      });
    } catch (err) {
      log?.warn?.("atlas", "ONNX inspect failed", { error: firstLine(err?.message || err) });
    }

    // NOTE: Startup worktree cleanup was previously a bootWarmup here. It is
    // now driven explicitly in the pre-scheduler DAG chain (above) so it
    // resolves BEFORE scheduler.boot acquires the lock and runs orphan
    // recovery. See run-session.js outer scope.
    const atlasWarmupBootConfig = getAtlasIntegrationConfig();
    // ATLAS/SCIP indexing runs as its OWN phase AFTER the upper boot section
    // (warmups + scheduler.boot), not concurrently inside bootWarmups — so the
    // checklist, providers, and the scheduler lock/orphan/pre-loop steps all
    // settle first and the ATLAS×SCIP matrix + zip own the final stretch before
    // the TUI. startAtlasWarmupPhase() is invoked post-scheduler.boot below; it
    // is intentionally NOT pushed into bootWarmups.
    startAtlasWarmupPhase = () => {
    if (atlasWarmupBootConfig?.enabled === false) {
      // ATLAS disabled at the config level — mark the step skipped and return a
      // resolved sentinel in the shape the bootWarmup would produce, rather than
      // running bootWarmup() (which would overwrite the "disabled" label).
      updateBootStep("ATLAS warmup", { status: "skipped", detail: "disabled", showDetail: true, force: true });
      return Promise.resolve({
        label: "ATLAS warmup",
        ok: true,
        fatal: false,
        result: {
          atlasBoot: { attempted: false, skipped: "atlas_disabled" },
          atlasRuntime: { attempted: false, skipped: "atlas_disabled", ok: true, backend: "atlas-v2" },
        },
      });
    }
    return bootWarmup("ATLAS warmup", async () => {
      const atlasBootConfig = atlasWarmupBootConfig;
      bootAtlasProgress = {
        percent: null,
        elapsedMs: 0,
        stage: "initializing",
        detail: "checking ATLAS commit hook",
        current: null,
        total: null,
        final: false,
        ok: null,
      };
      updateBootStep("ATLAS warmup", { detail: "ATLAS initializing", showDetail: false });
      const atlasHook = ensureAtlasCommitReindexHook({
        cwd: PROJECT_DIR,
        config: atlasBootConfig,
      });
      if (atlasHook.attempted && atlasHook.ok && atlasHook.changed) {
        const action = atlasHook.installed ? "installed" : (atlasHook.removed ? "removed stale hook" : "updated");
        const msg = `ATLAS commit hook: ${action} (${atlasHook.hookPath})`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
      } else if (atlasHook.attempted && !atlasHook.ok) {
        const msg = `ATLAS commit hook: failed (${atlasHook.error || "unknown error"})`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
      }
      bootAtlasProgress = {
        ...bootAtlasProgress,
        stage: "initializing",
        detail: "checking ATLAS index",
      };
      updateBootStep("ATLAS warmup", { detail: "ATLAS initializing", showDetail: false });
      let atlasBootStartedAt = null;
      let atlasBootOutputLines = 0;
      let atlasBootIndexPercent = null;
      let scipBootStartedAt = null;
      // True once the warm emits a view-build ("view") stage event — i.e. the
      // zip (layer merge) actually ran this boot. Gates whether we paint a
      // terminal state on the zip indicator (warm-cache skips build no view).
      let atlasZipStarted = false;
      let atlasEncodeStarted = false;
      // Tree-derived/compression refresh inside the view build ("tree" stage).
      // Terminal means a status:"ok"/"failed" event already painted the bar —
      // the boot-end sweep must not overwrite a failed tree row with "done".
      let atlasTreeStarted = false;
      let atlasTreeTerminal = false;
      const setAtlasBootIndexPercent = (value, { allowReset = false } = {}) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return atlasBootIndexPercent;
        const clamped = Math.max(0, Math.min(100, parsed));
        if (atlasBootIndexPercent == null || allowReset) {
          atlasBootIndexPercent = clamped;
        } else {
          atlasBootIndexPercent = Math.max(atlasBootIndexPercent, clamped);
        }
        return atlasBootIndexPercent;
      };
      const renderScipBootActivity = ({ elapsedMs = 0, final = false, ok = null, detail = null, current = null, total = null, percent = null } = {}) => {
        const text = firstLine(detail || "");
        const previousDetail = bootScipProgress?.detail || null;
        const parsedPercent = Number(percent);
        const failed = /(?:SCIP directory check failed|SCIP ingest failed|SCIP indexer failed|timed out|error)/i.test(text)
          || /,\s*[1-9]\d*\s*failed/i.test(text);
        const completed = final
          || failed
          || /(?:no staged SCIP files|no Posse SCIP indexer found|no SCIP indexer configured or found|staged \d+ SCIP file|found \d+ staged SCIP file|produced no \.scip files|already up-to-date|ingested,\s*\d+\s*failed)/i.test(text);
        bootScipProgress = {
          percent: Number.isFinite(parsedPercent) ? Math.max(0, Math.min(100, parsedPercent)) : null,
          elapsedMs,
          stage: completed ? "scip" : "checking",
          detail: text || null,
          current,
          total,
          final: completed,
          ok: failed ? false : (completed ? true : ok),
        };
        updateBootStep("ATLAS warmup", {
          status: failed ? "failed" : "running",
          percent: bootScipProgress.percent,
          detail: completed ? `SCIP ${text}` : "SCIP checking",
          showDetail: failed,
          force: final || (!!text && text !== previousDetail),
        });
        if (display && text) {
          const eventKey = `${failed ? "failed" : completed ? "complete" : "progress"}:${text.replace(/\s*\(\d+s elapsed\)$/i, "")}`;
          if (failed || final || eventKey !== lastScipBootActivityEventKey) {
            lastScipBootActivityEventKey = eventKey;
            display.addEvent(`${failed ? C.yellow : C.dim}SCIP: ${text}${C.reset}`);
          }
        }
      };
      const renderAtlasBootActivity = ({ elapsedMs = 0, final = false, ok = null, status = null, stage = null, detail = null, current = null, total = null } = {}) => {
        const seconds = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000));
        const stagePrefix = stage ? `${stage}: ` : "";
        const previousDetail = bootAtlasProgress?.detail || null;
        const tail = final
          ? (ok ? `index complete after ${seconds}s` : `index failed after ${seconds}s${status != null ? ` (exit ${status})` : ""}`)
          : detail
            ? `${stagePrefix}${firstLine(detail)}`
            : `${stagePrefix}${seconds}s elapsed, ${atlasBootOutputLines} output line${atlasBootOutputLines === 1 ? "" : "s"} captured`;
        bootAtlasProgress = {
          percent: atlasBootIndexPercent,
          elapsedMs,
          stage: stage || "indexing",
          detail: detail ? firstLine(detail) : null,
          current,
          total,
          final,
          ok,
        };
        const patch = {
          status: "running",
          detail: final ? `ATLAS ${tail}` : "ATLAS indexing",
          showDetail: final,
          force: final || (!!detail && firstLine(detail) !== previousDetail),
        };
        updateBootStep("ATLAS warmup", patch);
        if (display && (final || detail)) {
          const eventKey = `${final ? "final" : "progress"}:${tail.replace(/\s*\(\d+s elapsed\)$/i, "")}`;
          if (final || eventKey !== lastAtlasBootActivityEventKey) {
            lastAtlasBootActivityEventKey = eventKey;
            display.addEvent(`${C.dim}ATLAS indexing: ${tail}${C.reset}`);
          }
        }
      };
      // Captures the per-language SYMBOL total from encoding events so the
      // "done" detail can render "12.4K symbols" per language instead of
      // recycling a stale parsing-stage file count. Populated by the matrix
      // dispatch below when stage="encoding".
      /** @type {Map<string, number>} */
      const atlasSymbolsByLang = new Map();

      const atlasBootPromise = new Promise((resolve) => setImmediate(resolve)).then(() => ensureAtlasRepoIndexedOnBoot({
        cwd: PROJECT_DIR,
        config: getAtlasIntegrationConfig(),
        onBackgroundComplete: ({ ok, repoId, graphDbPath, error }) => {
          const tail = repoId ? ` for ${repoId}` : "";
          const msg = ok
            ? `ATLAS background reindex: complete${tail}`
            : `ATLAS background reindex: failed${tail} — continuing with prior graph (${error || graphDbPath || "unknown"})`;
          if (display) {
            const color = ok ? C.dim : C.yellow;
            display.addEvent(`${color}${msg}${C.reset}`);
          } else {
            updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
          }
        },
        onProgress: (event) => {
          // Progress fires during the synchronous boot reindex so large
          // codebases don't look hung. Keep stdout compact: the indexer's raw
          // output is still captured for diagnostics, but boot only shows a
          // single activity indicator plus a final status line.
          // ── Per-language matrix routing (new panel) ──────────────────
          // SCIP emits the indexer id as `language` (for example
          // `typescript`) and the source buckets it actually covers as
          // `source_languages` (`js`, `ts`, or both). The matrix must track
          // the source buckets, because ATLAS parses/encodes them separately.
          const eventLanguages = (() => {
            const raw = Array.isArray(event.source_languages)
              ? event.source_languages
              : Array.isArray(event.sourceLanguages)
                ? event.sourceLanguages
                : [];
            const sourceLangs = raw
              .map((value) => String(value || "").trim().toLowerCase())
              .filter(Boolean);
            if (sourceLangs.length > 0) return [...new Set(sourceLangs)];
            const fallback = String(event.language || "").trim().toLowerCase();
            return fallback ? [fallback] : [];
          })();
          if (eventLanguages.length > 0) {
            const kind = String(event.kind || "");
            const stage = String(event.stage || "");
            const percent = Number(event.percent ?? event.language_percent);
            const current = Number(event.language_current ?? event.current ?? event.progress_current);
            const total = Number(event.language_total ?? event.total ?? event.progress_total);
            // SCIP indexing → restage_* events / stage="scip" or stage="scip.indexing"
            // SCIP intaking → atlas.scip.ingest.* events
            // ATLAS parsing → stage in {checking,sampling,parsing,writing ledger,recording delta}
            // ATLAS encoding → stage="encoding"
            for (const lang of eventLanguages) {
              const scipEvent = scopeScipEventToSourceLanguage(event, lang);
              const scipPatch = bootScipLangPatchFromEvent(scipEvent);
              if (kind === "atlas.scip.restage_completed") {
                // NON-terminal: restage (the .scip generation) finished, but the
                // ingest/intake phase still follows. Keep the row in the blue
                // "indexing" phase at 100% — the ingest.* events below flip it to
                // the green "intaking" phase, then to done. Marking it done here
                // (the old behaviour) made the row read "100% indexed" and hid
                // the intaking phase entirely. finalizeLangRows() sweeps any row
                // that never receives an ingest event when the boot resolves.
                updateBootLang(lang, "scip", scipPatch);
              } else if (scipPatch) {
                updateBootLang(lang, "scip", scipPatch);
              } else if (stage === "cached"
                  || stage === "encoding"
                  || ["checking", "sampling", "parsing", "writing ledger", "recording delta", "indexing"].includes(stage)) {
                // Prefer the per-language fields when present (ParseEngine
                // now emits one event per language with consistent counts).
                // Fall back to event.current / event.total for event sources
                // that don't carry the language_* prefix — those events are
                // already implicitly scoped to event.language. Bar % is
                // computed from whichever pair we picked so the bar always
                // matches the N/M shown in the detail.
                const rawLangCurrent = Number(event.language_current);
                const rawLangTotal = Number(event.language_total);
                const hasLangScoped = Number.isFinite(rawLangCurrent) && Number.isFinite(rawLangTotal) && rawLangTotal > 0;
                const fallbackCurrent = Number(event.current ?? event.progress_current);
                const fallbackTotal = Number(event.total ?? event.progress_total);
                const hasFallback = Number.isFinite(fallbackCurrent) && Number.isFinite(fallbackTotal) && fallbackTotal > 0;
                const usedCurrent = hasLangScoped ? rawLangCurrent : (hasFallback ? fallbackCurrent : 0);
                const usedTotal = hasLangScoped ? rawLangTotal : (hasFallback ? fallbackTotal : 0);
                const hasCount = usedTotal > 0;
                const computedPercent = hasCount
                  ? Math.max(0, Math.min(100, (usedCurrent / usedTotal) * 100))
                  : null;
                if (stage === "cached") {
                  const detail = firstLine(event.text || "") || (hasCount ? `${usedTotal} files current` : "up-to-date");
                  updateBootLang(lang, "atlas", {
                    state: "done",
                    current: hasCount ? usedCurrent : 0,
                    total: hasCount ? usedTotal : 0,
                    percent: 100,
                    detail,
                  });
                } else if (stage === "encoding") {
                  // Encoding runs AFTER the view merge and is NOT a phase on the
                  // atlas language row — it drives its own global "encode" bottom
                  // bar (so the atlas row never snaps parsing-100% → encoding-0%).
                  // Still capture the per-language symbol total so the atlas row's
                  // done detail can read "12.4K symbols".
                  if (hasCount) {
                    atlasSymbolsByLang.set(lang, Math.max(atlasSymbolsByLang.get(lang) || 0, usedTotal));
                  }
                  // The encode bar shows OVERALL progress across all languages —
                  // the event carries it in progress_current/progress_total/percent,
                  // identical on every per-language iteration, so this is idempotent.
                  const overallCurrent = Number(event.progress_current ?? event.current);
                  const overallTotal = Number(event.progress_total ?? event.total);
                  const overallPercent = Number.isFinite(Number(event.percent))
                    ? Number(event.percent)
                    : (Number.isFinite(overallCurrent) && Number.isFinite(overallTotal) && overallTotal > 0
                      ? (overallCurrent / overallTotal) * 100
                      : null);
                  atlasEncodeStarted = true;
                  bootPanel.updateEncode({
                    state: "building",
                    percent: overallPercent,
                    detail: (Number.isFinite(overallCurrent) && Number.isFinite(overallTotal) && overallTotal > 0)
                      ? `${overallCurrent}/${overallTotal} symbols`
                      : "encoding",
                  });
                  if (!atlasBootBackgroundRequested) {
                    updateBootFooter("hit Enter to load ONNX in the background");
                    setBootEnterAction(() => requestAtlasBootBackground("enter"));
                  }
                } else {
                  const detail = hasCount
                    ? `parsing ${usedCurrent}/${usedTotal} files`
                    : (event.text || "parsing");
                  updateBootLang(lang, "atlas", {
                    state: "parsing",
                    current: hasCount ? usedCurrent : 0,
                    total: hasCount ? usedTotal : 0,
                    percent: computedPercent,
                    detail,
                  });
                }
              }
            }
          }
          // The view build ("zip") runs after ATLAS + SCIP have landed in the
          // ledger and carries no language. Drive the dedicated zip indicator
          // off its stage events so the merge is visible before the TUI starts.
          if (String(event.stage || "") === "view") {
            atlasZipStarted = true;
            const zipPercent = Number(event.percent ?? event.progress_percent);
            const zipDetail = firstLine(event.text || "") || "merging layers";
            const zipDone = (Number.isFinite(zipPercent) && zipPercent >= 100)
              || /\bmerged\b/i.test(zipDetail);
            bootPanel.updateZip({
              state: zipDone ? "done" : "building",
              percent: Number.isFinite(zipPercent) ? zipPercent : null,
              detail: zipDetail,
            });
          }
          // The tree-derived/compression refresh runs inside the view build and
          // drives its own bar. Its terminal event carries status ok/failed —
          // failed stays failed (e.g. compression has no Node fallback and the
          // native atlas binary is disabled).
          if (String(event.stage || "") === "tree") {
            atlasTreeStarted = true;
            const treePercent = Number(event.percent ?? event.progress_percent);
            const treeDetail = firstLine(event.text || "") || "building tree";
            const treeStatus = String(event.status || "");
            if (treeStatus === "failed") {
              atlasTreeTerminal = true;
              bootPanel.updateTree({ state: "failed", detail: treeDetail });
            } else if (treeStatus === "ok") {
              atlasTreeTerminal = true;
              bootPanel.updateTree({ state: "done", percent: 100, detail: treeDetail });
            } else {
              bootPanel.updateTree({
                state: "building",
                percent: Number.isFinite(treePercent) ? treePercent : null,
                detail: treeDetail,
              });
            }
          }
          if (event.kind === "start") {
            atlasBootStartedAt = Date.now();
            atlasBootOutputLines = 0;
            setAtlasBootIndexPercent(0);
            renderAtlasBootActivity({ elapsedMs: 0, stage: event.stage || null });
          } else if (event.kind === "line") {
            const text = String(event.text || "");
            if (!text.trim()) return;
            if (event.stage === "scip" || event.stage === "scip.indexing") {
              if (scipBootStartedAt == null) scipBootStartedAt = Date.now();
              renderScipBootActivity({
                elapsedMs: event.elapsedMs ?? (Date.now() - scipBootStartedAt),
                detail: text.trimEnd(),
                current: event.current ?? event.progress_current ?? null,
                total: event.total ?? event.progress_total ?? null,
                percent: atlasProgressPercentFromEvent(event),
              });
              return;
            }
            atlasBootOutputLines += 1;
            const eventPercent = atlasProgressPercentFromEvent(event);
            const textPercent = parseAtlasProgressPercent(text);
            const parsedPercent = eventPercent == null
              ? textPercent
              : textPercent == null
                ? eventPercent
                : Math.max(eventPercent, textPercent);
            setAtlasBootIndexPercent(parsedPercent);
            renderAtlasBootActivity({
              elapsedMs: event.elapsedMs,
              stage: event.stage || event.stream || null,
              detail: text.trimEnd(),
              current: event.current ?? event.progress_current ?? null,
              total: event.total ?? event.progress_total ?? null,
            });
          } else if (event.kind === "heartbeat") {
            const parsedPercent = atlasProgressPercentFromEvent(event);
            if (event.stage === "scip" || event.stage === "scip.indexing") {
              if (scipBootStartedAt == null) scipBootStartedAt = Date.now();
              const heartbeatDetail = event.detail || bootScipProgress?.detail || null;
              const heartbeatSeconds = Math.max(0, Math.round((Number(event.elapsedMs) || 0) / 1000));
              renderScipBootActivity({
                elapsedMs: event.elapsedMs,
                detail: heartbeatDetail ? `${firstLine(heartbeatDetail)} (${heartbeatSeconds}s elapsed)` : null,
                current: event.current ?? event.progress_current ?? bootScipProgress?.current ?? null,
                total: event.total ?? event.progress_total ?? bootScipProgress?.total ?? null,
                percent: parsedPercent ?? bootScipProgress?.percent ?? null,
              });
              return;
            }
            setAtlasBootIndexPercent(parsedPercent);
            const heartbeatDetail = event.detail || bootAtlasProgress?.detail || null;
            const heartbeatSeconds = Math.max(0, Math.round((Number(event.elapsedMs) || 0) / 1000));
            renderAtlasBootActivity({
              elapsedMs: event.elapsedMs,
              stage: event.stage || bootAtlasProgress?.stage || null,
              detail: heartbeatDetail ? `${firstLine(heartbeatDetail)} (${heartbeatSeconds}s elapsed)` : null,
              current: event.current ?? event.progress_current ?? bootAtlasProgress?.current ?? null,
              total: event.total ?? event.progress_total ?? bootAtlasProgress?.total ?? null,
            });
          } else if (event.kind === "end") {
            const elapsedMs = atlasBootStartedAt ? Date.now() - atlasBootStartedAt : event.elapsedMs;
            if (event.ok) setAtlasBootIndexPercent(100);
            if (bootScipProgress && !bootScipProgress.final) {
              bootScipProgress = {
                ...bootScipProgress,
                elapsedMs: scipBootStartedAt ? Date.now() - scipBootStartedAt : bootScipProgress.elapsedMs,
                final: true,
                ok: event.ok !== false,
              };
            }
            renderAtlasBootActivity({ elapsedMs, final: true, ok: event.ok, status: event.status, stage: event.stage || null });
          }
        },
      }));
      atlasWarmCompletion = atlasBootPromise;
      const atlasBoot = await atlasBootPromise;
      // Finalize per-language matrix rows when ATLAS boot returns. Cache-hit
      // paths only need waiting rows flipped to done; successful refreshes can
      // also leave an active SCIP child row stale if its final event raced the
      // worker boundary, so close non-terminal rows too.
      const finalizeLangRows = ({
        waitingState = "done",
        waitingDetail = "up-to-date",
        activeAtlasDetail = "ready",
        // A SCIP row left active at boot-end is indexed-but-nothing-to-intake
        // (the .scip carried no docs for this source bucket) — that's done, not
        // a "background" job. Show "indexed" rather than the old "background".
        activeScipDetail = "indexed",
      } = {}) => {
        const resolveDetail = (raw, lang) => (typeof raw === "function" ? raw(lang) : raw);
        for (const [lang, entry] of bootPanel.languageEntries()) {
          for (const side of ["atlas", "scip"]) {
            const state = entry?.[side]?.state;
            if (!state || TERMINAL_BOOT_LANG_STATES.has(state)) continue;
            if (state === "waiting" || state === "idle") {
              updateBootLang(lang, side, {
                state: waitingState,
                detail: resolveDetail(waitingDetail, lang),
                percent: waitingState === "done" ? 100 : null,
              });
            } else if (side === "atlas") {
              updateBootLang(lang, side, {
                state: "done",
                detail: resolveDetail(activeAtlasDetail, lang),
                percent: 100,
              });
            } else {
              // Boot only resolves once the index work has actually finished,
              // so a SCIP row still in an active state here just never received
              // its terminal ingest event (e.g. the .scip carried no docs for
              // this source bucket). It's done at 100%, not a backgrounded job —
              // render it as a complete green bar, not the yellow "/" deferred.
              updateBootLang(lang, side, {
                state: "done",
                detail: resolveDetail(activeScipDetail, lang),
                percent: 100,
              });
            }
          }
        }
      };
      const finalizeWaitingLangRows = (state, detail) => finalizeLangRows({
        waitingState: state,
        waitingDetail: detail,
        activeAtlasDetail: detail,
        activeScipDetail: detail,
      });
      if (!atlasBoot.attempted && atlasBoot.skipped === "index_present") {
        const msg = `ATLAS boot check: index present (${atlasBoot.graphDbPath})`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
        finalizeWaitingLangRows("done", "up-to-date");
      } else if (!atlasBoot.attempted && atlasBoot.skipped === "head_unchanged") {
        const head = atlasBoot.head ? ` @ ${String(atlasBoot.head).slice(0, 8)}` : "";
        const msg = `ATLAS boot check: index up-to-date${head} (skipping reindex)`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
        finalizeWaitingLangRows("done", "up-to-date");
      } else if (!atlasBoot.attempted && atlasBoot.skipped !== "atlas_disabled") {
        const msg = `ATLAS boot check: skipped (${atlasBoot.skipped})`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
        finalizeWaitingLangRows("skipped", atlasBoot.skipped || "skipped");
      } else if (atlasBoot.attempted && atlasBoot.backgrounded) {
        const tail = atlasBoot.repoId ? ` for ${atlasBoot.repoId}` : "";
        const msg = `ATLAS boot check: reindex running in background${tail} (jobs use prior graph until it lands)`;
        updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
      } else if (atlasBoot.attempted && atlasBoot.ok) {
        if (atlasBootIndexPercent != null) setAtlasBootIndexPercent(100);
        if (atlasZipStarted) bootPanel.updateZip({ state: "done", percent: 100, detail: "merged" });
        if (atlasTreeStarted && !atlasTreeTerminal) bootPanel.updateTree({ state: "done", percent: 100, detail: "tree ready" });
        if (atlasEncodeStarted) bootPanel.updateEncode({ state: "done", percent: 100, detail: "encoded" });
        if (!atlasBootBackgroundRequested) {
          updateBootFooter("");
          setBootEnterAction(null);
        }
        const recoveryNote = atlasBoot.recoveryAttempted && atlasBoot.recoveryOk
          ? ` (recovered from graph corruption — ${atlasBoot.recoveredFiles.length} file${atlasBoot.recoveredFiles.length === 1 ? "" : "s"} rebuilt)`
          : "";
        const bootResult = atlasBoot.result || {};
        const changed = Number(bootResult.freshness_paths_changed ?? bootResult.paths_indexed ?? 0);
        const hashed = Number(bootResult.freshness_paths_hashed ?? 0);
        const statHits = Number(bootResult.freshness_stat_matches ?? 0);
        const freshnessTail = bootResult.purpose === "main-incremental" && changed === 0
          ? `source freshness checked (${statHits} stat hits, ${hashed} hashed)`
          : "index refreshed";
        const msg = `ATLAS boot check: ${freshnessTail}${atlasBoot.repoId ? ` for ${atlasBoot.repoId}` : ""}${recoveryNote}`;
        if (bootAtlasProgress) {
          bootAtlasProgress = {
            ...bootAtlasProgress,
            percent: 100,
            elapsedMs: atlasBootStartedAt ? Date.now() - atlasBootStartedAt : bootAtlasProgress.elapsedMs,
            detail: msg,
            final: true,
            ok: true,
          };
        }
        updateBootStep("ATLAS warmup", {
          detail: msg,
          showDetail: true,
        });
        // Per-language done detail: show the total symbol count (or file count
        // as a fallback) so a finished row reads "12.4K symbols" instead of
        // a stale "6/6 files" left over from the last parsing tick.
        const formatCount = (n) => {
          if (!Number.isFinite(n) || n <= 0) return null;
          if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
          if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
          return String(Math.round(n));
        };
        finalizeLangRows({
          waitingState: "done",
          waitingDetail: "up-to-date",
          activeAtlasDetail: (lang) => {
            const symbols = atlasSymbolsByLang.get(lang);
            if (symbols) {
              const formatted = formatCount(symbols);
              if (formatted) return `${formatted} symbols`;
            }
            return "ready";
          },
          activeScipDetail: "background",
        });
      } else if (atlasBoot.attempted && !atlasBoot.ok) {
        const detail = (atlasBoot.error || atlasBoot.stderr || atlasBoot.stdout || "").split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${atlasBoot.status}`;
        if (atlasZipStarted) bootPanel.updateZip({ state: "failed", detail: "view build failed" });
        if (atlasTreeStarted && !atlasTreeTerminal) bootPanel.updateTree({ state: "failed", detail: "view build failed" });
        if (atlasEncodeStarted) bootPanel.updateEncode({ state: "failed", detail: "encode failed" });
        if (!atlasBootBackgroundRequested) {
          updateBootFooter("");
          setBootEnterAction(null);
        }
        disableAtlasForRun(`boot_reindex_failed: ${detail}`, atlasBoot.repoId || atlasBoot.graphDbPath || PROJECT_DIR);
        const msg = `ATLAS boot check: indexing failed${atlasBoot.repoId ? ` for ${atlasBoot.repoId}` : ""} (${detail})`;
        const noteMsg = "ATLAS disabled for this run — tools, gate, and MCP attachment fall back to baseline. Restart after fixing the reindex error to re-enable.";
        log.warn("atlas", "Boot index failed — ATLAS disabled for this run", {
          repoId: atlasBoot.repoId || null,
          graphDbPath: atlasBoot.graphDbPath || null,
          status: atlasBoot.status,
          detail,
          stderrTail: (atlasBoot.stderr || "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ") || null,
        });
        if (bootAtlasProgress) {
          bootAtlasProgress = {
            ...bootAtlasProgress,
            elapsedMs: atlasBootStartedAt ? Date.now() - atlasBootStartedAt : bootAtlasProgress.elapsedMs,
            detail: msg,
            final: true,
            ok: false,
          };
        }
        updateBootStep("ATLAS warmup", {
          detail: `${msg}; ${noteMsg}`,
          showDetail: true,
        });
      }
      renderAtlasBootActivity({
        elapsedMs: atlasBootStartedAt ? Date.now() - atlasBootStartedAt : bootAtlasProgress?.elapsedMs || 0,
        stage: "native",
        detail: "ATLAS v2 native backend ready",
      });
      const atlasRuntime = { attempted: false, skipped: "native_v2", ok: true, backend: "atlas-v2" };
      const msg = "ATLAS v2 native backend ready";
      bootAtlasProgress = {
        ...(bootAtlasProgress || {}),
        stage: "native",
        detail: msg,
        final: true,
        ok: true,
      };
      updateBootStep("ATLAS warmup", { detail: msg, showDetail: true });
      return { atlasBoot, atlasRuntime };
    }, {
      done: ({ atlasBoot, atlasRuntime } = {}, ok) => {
        if (ok) return "warm";
        if (atlasBoot?.attempted && atlasBoot.ok === false) {
          const detail = firstLine(atlasBoot.error || atlasBoot.stderr || atlasBoot.stdout || `exit ${atlasBoot.status ?? "unknown"}`);
          return `index failed (${detail})`;
        }
        if (atlasRuntime?.attempted && atlasRuntime.ok === false) {
          return `runtime failed (${firstLine(atlasRuntime.error || atlasRuntime.skipped || "unknown")})`;
        }
        return "finished with warnings";
      },
      isOk: ({ atlasBoot, atlasRuntime } = {}) => (
        !(atlasBoot?.attempted && atlasBoot.ok === false) &&
        !(atlasRuntime?.attempted && atlasRuntime.ok === false)
      ),
      // Keep a soft-timeout so the rest of boot can settle, then expose an
      // explicit Enter-to-background escape hatch while the pre-loop gate keeps
      // waiting for ATLAS unless the user releases it.
      softTimeoutMs: Number.isFinite(Number(atlasWarmupBootConfig?.bootSoftTimeoutMs))
        ? Math.max(0, Number(atlasWarmupBootConfig.bootSoftTimeoutMs))
        : 33 * 60 * 1000,
      softTimeoutDetail: "indexing — press Enter to background",
      // The pre-TUI gate below keeps waiting on the warm after this step's
      // soft-timeout, so the chip must stay "running": marking it ok here made
      // the whole panel read 100%/ready while boot was still blocked on the
      // warm (and only an Enter — or the warm finishing — would advance it).
      softTimeoutStatus: "running",
      onSoftTimeout: () => {
        if (atlasBootBackgroundRequested) return;
        updateBootFooter("hit Enter to continue with ATLAS in the background");
        setBootEnterAction(() => requestAtlasBootBackground("atlas-soft-timeout-enter"));
      },
    });
    };

    let bootWarmupResults;
    try {
      bootWarmupResults = await Promise.all(bootWarmups);
      const fatalWarmup = bootWarmupResults.find((result) => result.fatal && !result.ok);
      if (fatalWarmup) {
        updateBootStep("pre-loop hooks", {
          status: "failed",
          detail: `${fatalWarmup.label} failed`,
          showDetail: true,
          force: true,
        });
        throw fatalWarmup.error || new Error(`${fatalWarmup.label} failed`);
      }
      updateBootStep("pre-loop hooks", { status: "ok", force: true });
      // SCIP + ATLAS greenlight: both indexers have settled. Kick off the
      // local-ONNX encoder warm in a worker thread so the @huggingface
      // pipeline parse runs off the main loop. Fire-and-forget — failures
      // log to diagnostics only; the banner phase-2 colour will animate via
      // the vector-DB-fill signal once it's wired.
      if (onnxStatusAtBoot && onnxStatusAtBoot.status === "ready") {
        const onnxWorkerUrl = new URL("./onnx-warm-worker.js", import.meta.url);
        const onnxWarmManager = new RunThreadManager();
        setOnnxWarmState({ phase: "loading", startedAt: Date.now(), finishedAt: null, error: null });
        onnxWarmManager.run(onnxWorkerUrl, {
          label: "ONNX encoder warm",
          timeoutMs: 5 * 60 * 1000,
          unref: true,
          workerData: {
            cacheDir: onnxStatusAtBoot.cacheDir,
            modelName: onnxStatusAtBoot.modelName,
            modelId: onnxStatusAtBoot.model,
            dim: onnxStatusAtBoot.dim,
          },
          onProgress: (event) => {
            // Worker emits stage="loading" at start and stage="ready" on
            // completion. The "loading" event is informational — the chip
            // already moved to "loading" via setOnnxWarmState above.
            if (event?.stage === "ready") {
              setOnnxWarmState({ phase: "ready", finishedAt: Date.now() });
            }
          },
          onLifecycle: (event) => {
            recordEmbeddingForensics("onnx.warm_thread.lifecycle", {
              ...event,
              model_id: onnxStatusAtBoot.model,
              model_name: onnxStatusAtBoot.modelName,
              dim: onnxStatusAtBoot.dim,
            });
          },
        }).then(
          () => {
            // Worker `result` arrives after the final "ready" progress event;
            // make sure the chip is in a terminal state even if the progress
            // message was lost.
            if (getOnnxWarmState && getOnnxWarmState().phase === "loading") {
              setOnnxWarmState({ phase: "ready", finishedAt: Date.now() });
            }
          },
          (err) => {
            const msg = firstLine(err?.message || err) || "unknown";
            log?.warn?.("atlas", "ONNX encoder warm failed", { error: msg });
            setOnnxWarmState({ phase: "failed", finishedAt: Date.now(), error: msg });
          },
        );
      }
    } catch (err) {
      bootAbortReason = firstLine(err?.message || err) || "pre-loop hooks failed";
      updateBootStep("pre-loop hooks", {
        status: "failed",
        detail: bootAbortReason,
        showDetail: true,
        force: true,
      });
      throw err;
    }
    // NB: do NOT stopBootMonitor here. onBeforeLoop runs inside scheduler.boot,
    // BEFORE the scheduler's own runHealthChecks (workspace health + provider
    // liveness) and BEFORE the post-boot ATLAS/SCIP index phase. Disposing the
    // panel now would render all of those to a dead monitor — leaving workspace
    // health pending, the provider chips frozen at their pre-dispose state, and
    // the ATLAS×SCIP matrix stuck at "waiting". The panel is finalized exactly
    // once, just before the TUI attaches (the stopBootMonitor below). Failure
    // paths dispose via the !booted branch and the bootAbortController handler.
  };

  // Handle shutdowns while scheduler.boot() is still running. The worker-aware
  // cleanup handler is installed after boot, but boot itself can hold the
  // scheduler lock while slow pre-loop hooks run.
  let bootSignalCount = 0;
  let bootShutdownRequested = false;
  let bootCleanupPromise = null;
  const cleanupDuringBoot = (signal = "SIGINT") => {
    bootSignalCount++;
    if (bootSignalCount >= 2) {
      try { scheduler.requestStop?.(); } catch { /* best-effort */ }
      void cleanupAtlasForSession({ label: "Forced shutdown" });
      closeRuntimeStateForExit();
      process.exit(1);
    }

    if (bootShutdownRequested) return;
    bootShutdownRequested = true;
    bootAbortController.abort(new Error(`${signal} during scheduler boot`));
    const label = signal === "SIGTERM" ? "Shutdown" : "Ctrl+C";
    console.log(`\n  ${C.yellow}${label} during boot - releasing scheduler lock...${C.reset}`);
    console.log(`  ${C.dim}(Ctrl+C again to force-exit)${C.reset}`);
    const stopPromise = scheduleSchedulerStop();
    bootCleanupPromise = Promise.allSettled([
      stopPromise,
      cleanupAtlasForSession({ label: "Boot cleanup" }),
    ]).then(() => undefined);
    void bootCleanupPromise;
  };
  const bootSigintCleanup = () => cleanupDuringBoot("SIGINT");
  const bootSigtermCleanup = () => cleanupDuringBoot("SIGTERM");
  const bootSigbreakCleanup = () => cleanupDuringBoot("SIGBREAK");
  const bootMessageCleanup = (msg) => { if (msg === "shutdown") cleanupDuringBoot("SIGTERM"); };

  process.on("SIGINT", bootSigintCleanup);
  process.on("SIGTERM", bootSigtermCleanup);
  if (process.platform === "win32") {
    process.on("SIGBREAK", bootSigbreakCleanup);
    process.on("message", bootMessageCleanup);
  }

  let booted = false;
  try {
    booted = await scheduler.boot({
      onBeforeLoop,
      onBeforeLoopFatal: true,
      onBootEvent: handleSchedulerBootEvent,
    });
  } finally {
    process.off("SIGINT", bootSigintCleanup);
    process.off("SIGTERM", bootSigtermCleanup);
    if (process.platform === "win32") {
      process.off("SIGBREAK", bootSigbreakCleanup);
      process.off("message", bootMessageCleanup);
    }
  }
  if (!booted) {
    // Boot failed/aborted — tear the panel down so we leave clean stdout
    // for the user-facing message below.
    try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    if (bootShutdownRequested) {
      if (bootCleanupPromise) await bootCleanupPromise;
      console.log(`  ${C.yellow}Scheduler boot interrupted. Lock released; safe to restart.${C.reset}\n`);
    } else if (bootAbortReason) {
      console.log(`  ${C.red}Scheduler boot aborted — ${bootAbortReason}.${C.reset}\n`);
    } else {
      console.log(`  ${C.red}Scheduler boot aborted — another instance may be running or lock is held.${C.reset}\n`);
    }
    return;
  }

  // Settle the top-level provider warmups before the TUI attaches so their
  // chips show a final terminal state. The auth/usage primes are internally
  // bounded, so this waits only as long as the bounded warm — gating the index
  // phase until provider auth resolves.
  await Promise.allSettled(providerWarmups);

  // ── Indexing phase ─────────────────────────────────────────────────────
  // The entire upper boot section has settled (warmups + providers + scheduler
  // lock/orphan/pre-loop). Kick the ATLAS/SCIP warm now so the top of the panel
  // finishes independently before the ATLAS×SCIP matrix + zip take over. This
  // returns at the warm's soft-timeout; the real work continues and is awaited
  // by the gate just below, so the panel keeps animating live progress.
  if (startAtlasWarmupPhase) {
    await startAtlasWarmupPhase();
  }

  // ── TUI attach — from here on, stdout goes to the alt-screen buffer ─────
  // Final the boot panel before the alt-screen takes over so the last frame
  // lands as scrollback above the TUI rather than mid-spinner.
  // stopBootMonitor → renderBootMonitor(final) → terminalOutputIntercept.release()
  // replays anything that tried to write to stdout/stderr while the panel was up.
  // Pre-flight gate: wait for the ATLAS index to finish building before the
  // runtime UI attaches and workers start. The warm runs in the boot worker
  // (off the event loop), so the scheduler lock keeps renewing while we wait —
  // jobs see a current index instead of one still building in the background.
  if (atlasWarmCompletion) {
    const disableAtlasAfterBackgroundFailure = (reason) => {
      try { disableAtlasForRun(`boot_background_failed: ${firstLine(reason)}`, PROJECT_DIR); } catch { /* best effort */ }
    };
    const watchAtlasCompletion = () => {
      void atlasWarmCompletion.then(
        (result) => {
          if (!atlasBootBackgroundRequested) return;
          if (result?.ok === false) {
            const reason = result.error || result.stderr || result.stdout || "not ok";
            log?.warn?.("atlas", "Background ATLAS/ONNX boot work failed", {
              reason: atlasBootBackgroundReason,
              error: firstLine(reason),
            });
            disableAtlasAfterBackgroundFailure(reason);
            return;
          }
          log?.info?.("atlas", "Background ATLAS/ONNX boot work completed", {
            reason: atlasBootBackgroundReason,
          });
        },
        (err) => {
          log?.warn?.("atlas", "Background ATLAS/ONNX boot work failed", {
            reason: atlasBootBackgroundReason,
            error: firstLine(err?.message || err),
          });
          disableAtlasAfterBackgroundFailure(err?.message || err);
        },
      );
    };
    try {
      const outcome = await Promise.race([
        atlasWarmCompletion.then(
          () => ({ kind: "complete" }),
          (error) => ({ kind: "error", error }),
        ),
        atlasBootBackgroundRequest,
      ]);
      if (outcome?.kind === "background") {
        updateBootStep("ATLAS warmup", {
          status: "deferred",
          detail: "ATLAS/ONNX loading in background",
          showDetail: true,
          force: true,
        });
        watchAtlasCompletion();
      } else if (outcome?.kind === "error") {
        throw outcome.error;
      }
    } catch (err) {
      log?.warn?.("atlas", "ATLAS boot wait failed; entering TUI with ATLAS disabled", {
        error: firstLine(err?.message || err),
      });
      try { disableAtlasForRun(`boot_wait_failed: ${firstLine(err?.message || err)}`, PROJECT_DIR); } catch { /* best effort */ }
    }
  }

  // Resolve any pre-seeded step that never ran this boot (e.g. the git/worktree
  // steps when no queued job needs a worktree) to "skipped" so the final
  // checklist has no lingering "-" pending markers.
  for (const [label, step] of bootSteps.entries()) {
    if (step.status === "pending") {
      updateBootStep(label, { status: "skipped", force: true });
    }
  }

  try {
    recordRunDiagnostic("boot.ready_handoff", {
      use_tui: !!useTui,
      stdout_is_tty: !!process.stdout.isTTY,
      has_pending_queue_snapshot: !!pendingQueueSnapshot,
      atlas_backgrounded: !!atlasBootBackgroundRequested,
    });
  } catch { /* observational */ }

  stopBootMonitor({ final: true });
  if (useTui) {
    try { recordRunDiagnostic("display.starting", { concurrency: CONCURRENCY }); } catch { /* observational */ }
    display = new Display({ concurrency: CONCURRENCY });
    // Replay the most recent queue snapshot the scheduler has emitted so
    // the display opens with a fully populated view instead of a blank
    // frame that waits for the next state change.
    if (pendingQueueSnapshot && typeof display.acceptQueueSnapshot === "function") {
      display.acceptQueueSnapshot(pendingQueueSnapshot);
    }
    setupDisplaySnapshotCaches();
    display.start();
    try { recordRunDiagnostic("display.started", { concurrency: CONCURRENCY }); } catch { /* observational */ }
    display.addEvent(`${C.green}Boot complete — entering main loop${C.reset}`);
  }

  const worker = new Worker({ autoApprove: AUTO_APPROVE, projectDir: PROJECT_DIR, display, dryRun: DRY_RUN, stallTimeout: STALL_TIMEOUT, leaseSec: scheduler.leaseSec });

  if (display) {
    const revivedHumanJobs = requeueWaitingHumanInputJobs();
    for (const { work_item_id } of revivedHumanJobs) {
      refreshWorkItemStatus(work_item_id);
    }
    if (revivedHumanJobs.length > 0) {
      display.addEvent(`${C.cyan}Requeued ${revivedHumanJobs.length} parked human prompt(s)${C.reset}`);
    }
  }

  // Tracks an in-flight live review ('r' keybinding) so wrap-up can wait for
  // its closeout instead of re-entering approval mode over a live session.
  let liveReviewPromise = null;

  // Wire inject keybinding — pressing 'i' in the TUI creates a work item + research/plan jobs
  if (display) {
    display.onInject = (description) => {
      const title = description.split("\n")[0].slice(0, 100);
      const mode = inferWiMode(description) || "build";
      const deepthinkBudget = "normal";
      const item = createWorkItem(title, description, "normal", {
        source: "inject",
        mode,
        metadata: researchBudgetMetadata({}, deepthinkBudget),
      });
      updateWorkItemStatus(item.id, "planning");
      createInitialResearchOrPlanJob(item, {
        deepthinkBudget,
        source: "tui_inject",
        redTeamPlan: shouldUseRedTeamPlanForWorkItem(item),
        routing: classifyResearchForRouting({ workItem: item, mode, source: "tui_inject", live: true }),
      });
    };

    // Wire image keybinding — pressing 'g' generates an image directly
    display.onImage = (prompt) => {
      const title = prompt.split("\n")[0].slice(0, 100);
      const item = createWorkItem(title, prompt, "normal", { source: "image", mode: "image" });
      ensureArtifactDirs(wiScopeId(item.id), "image", PROJECT_DIR);
      const outputRoot = artifactsDir(wiScopeId(item.id), PROJECT_DIR).replace(/\\/g, "/");
      const protocol = getResolvedImageProtocol();
      const imgProvider = protocol.provider || "openai";

      updateWorkItemStatus(item.id, "running");
      createJob({
        work_item_id: item.id,
        job_type: "artificer",
        title: `Generate: ${title.slice(0, 70)}`,
        priority: "normal",
        model_tier: "standard",
        reasoning_effort: "medium",
        provider: imgProvider,
        payload_json: JSON.stringify(buildImageInjectionPayload({ prompt, outputRoot })),
      });
    };

    // Wire kill keybinding — pressing 'k' lets user kill a stuck worker
    display.onKill = (jobId) => {
      const killed = worker.killJob(jobId, "user_canceled");
      if (killed) {
        display.addEvent(`${C.red}\u26a1 Killed worker for job #${jobId} — will retry${C.reset}`);
      } else {
        display.addEvent(`${C.yellow}No active process found for job #${jobId}${C.reset}`);
      }
    };

    // Wire nudge keybinding — pressing 'n' kills a running job and injects a correction
    display.onNudge = (jobId, correction) => {
      // Store the correction as a nudge artifact BEFORE killing, so it's
      // available when the retry starts.
      storeArtifact({
        work_item_id: getJob(jobId)?.work_item_id,
        job_id: jobId,
        artifact_type: "nudge",
        content_long: correction,
      });

      logEvent({
        work_item_id: getJob(jobId)?.work_item_id,
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_NUDGED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Human correction: ${correction.slice(0, 200)}`,
      });

      const killed = worker.killJob(jobId, "user_nudge");
      if (killed) {
        display.addEvent(`${C.cyan}\u270e Nudged job #${jobId} — will retry with correction${C.reset}`);
      } else {
        display.addEvent(`${C.cyan}\u270e Correction stored for job #${jobId} (not currently running)${C.reset}`);
      }
    };

    // Wire kill-WI keybinding — pressing 'x' cancels an entire work item
    display.onKillWI = (wiId) => {
      const wi = getWorkItem(wiId);
      if (!wi) return;

      // Kill any running workers for this WI
      for (const [jobId, w] of display.workers) {
        if (w.workItemId === wiId) {
          worker.killJob(jobId, "work_item_canceled");
        }
      }

      // Cancel all non-terminal jobs
      const canceled = cancelWorkItemJobs(wiId);
      updateWorkItemStatus(wiId, "canceled");

      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.WORK_ITEM_CANCELED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Work item canceled by user (${canceled.length} job(s) canceled)`,
      });

      if (!wi.branch_name) {
        display.addEvent(`${C.red}\u2717 WI#${wiId} canceled; ${canceled.length} job(s) stopped${C.reset}`);
        return;
      }

      display.addEvent(`${C.red}\u2717 WI#${wiId} canceled; ${canceled.length} job(s) stopped, branch cleanup running${C.reset}`);
      const cleanupRunner = typeof cleanupWiBranchAsync === "function"
        ? cleanupWiBranchAsync
        : null;
      if (!cleanupRunner) {
        display.addEvent(`${C.yellow}WI#${wiId} branch cleanup skipped: async cleanup unavailable${C.reset}`);
        return;
      }
      void cleanupRunner(wi, { clearMergeState: true })
        .then((cleanupOk) => {
          if (!cleanupOk) {
            display.addEvent(`${C.red}\u2717 WI#${wiId} branch cleanup failed${C.reset}`);
            return;
          }
          display.addEvent(`${C.green}\u2713 WI#${wiId} branch/worktree cleaned up${C.reset}`);
        })
        .catch((err) => {
          display.addEvent(`${C.red}\u2717 WI#${wiId} branch cleanup failed: ${String(err?.message || err)}${C.reset}`);
        })
        .finally(() => {
          refreshDisplaySnapshotsForQueue();
          display.requestRender?.({ reason: "event" });
        });
    };

    // Wire skip-task keybinding — pressing 's' skips a queued/blocked job
    display.onSkipJob = (jobId) => {
      try {
        const job = getJob(jobId);
        if (!job) return;

        const skipped = skipJob(jobId);
        if (skipped) {
          refreshWorkItemStatus(job.work_item_id);
          display.addEvent(`${C.yellow}\u23ed Skipped job #${jobId}: ${job.title.slice(0, 50)} — downstream unblocked${C.reset}`);
        } else {
          display.addEvent(`${C.yellow}Cannot skip job #${jobId} (${job.status})${C.reset}`);
        }
      } catch (err) {
        display.addEvent(`${C.red}Skip failed for job #${jobId}: ${err.message}${C.reset}`);
      }
    };

    display.onReviewPending = () => {
      if (liveReviewPromise) {
        display.addEvent(`${C.dim}Review is already open/running${C.reset}`);
        return;
      }
      liveReviewPromise = runLiveReview(display)
        .catch((err) => {
          display._mode = "normal";
          display.addEvent(`${C.red}Review failed: ${err.message}${C.reset}`);
          display.requestRender({ force: true });
        })
        .finally(() => {
          liveReviewPromise = null;
        });
    };

    // Wire ask keybinding — pressing '?' creates a research-only WI
    display.onAsk = (question) => {
      const title = question.split("\n")[0].slice(0, 100);
      const deepthinkBudget = "normal";
      const item = createWorkItem(title, question, "normal", {
        source: "ask",
        metadata: researchBudgetMetadata({ mode: "question" }, deepthinkBudget),
      });
      updateWorkItemStatus(item.id, "planning");
      classifyResearchForRouting({ workItem: item, mode: "question", source: "tui_ask", live: true });

      createJob({
        work_item_id: item.id,
        job_type: "research",
        title: `Ask: ${title.slice(0, 60)}`,
        priority: "normal",
        model_tier: defaultResearchModelTier(),
        reasoning_effort: researchBudgetToReasoningEffort(deepthinkBudget, "medium"),
        payload_json: JSON.stringify(researchPayload({}, deepthinkBudget)),
      });
    };
  }

  // Handle Ctrl+C gracefully — second press force-exits.
  // IMPORTANT: signal handlers are synchronous entry points. Keep the handler's
  // own stack non-blocking and queue any git/filesystem cleanup onto async work.
  let sigintCount = 0;
  let shutdownInProgress = false;
  let shutdownForceExitTimer = null;
  const emptyShutdownSweepSummary = () => ({
    swept: 0,
    snapshotted: 0,
    skippedDueBudget: 0,
    skippedActive: 0,
    skippedLockTimeout: 0,
    resetIncomplete: 0,
  });
  let shutdownCleanupPromise = null;
  let shutdownSweepSummary = emptyShutdownSweepSummary();
  const normalizeShutdownSweepSummary = (swept) => ({
    ...emptyShutdownSweepSummary(),
    ...(swept || {}),
  });
  const shutdownSweepSummaryLine = (swept) => `Shutdown dirty sweep: ${swept.swept} active worktree(s), ${swept.snapshotted} snapshot(s)${swept.skippedDueBudget ? `, ${swept.skippedDueBudget} skipped (time budget)` : ""}${swept.skippedActive ? `, ${swept.skippedActive} skipped (active sentinel)` : ""}${swept.skippedLockTimeout ? `, ${swept.skippedLockTimeout} skipped (lock busy)` : ""}${swept.resetIncomplete ? `, ${swept.resetIncomplete} incomplete reset(s)` : ""}${swept.sweepFailed ? `, skipped (${swept.error})` : ""}`;
  const reportShutdownSweep = (swept) => {
    if (display) {
      if (swept.swept > 0) {
        display.addEvent(`${C.dim}${shutdownSweepSummaryLine(swept)}${C.reset}`);
      } else if (swept.skippedLockTimeout > 0) {
        display.addEvent(`${C.dim}Shutdown dirty sweep skipped ${swept.skippedLockTimeout} worktree(s): lock busy${C.reset}`);
      } else if (swept.sweepFailed) {
        display.addEvent(`${C.dim}Shutdown dirty sweep skipped: ${swept.error}${C.reset}`);
      }
      display.requestRender({ force: true });
    } else if (swept.swept > 0 || swept.skippedLockTimeout > 0 || swept.sweepFailed) {
      console.log(`  ${C.dim}${shutdownSweepSummaryLine(swept)}${C.reset}`);
    }
  };
  const startShutdownDirtySweep = () => {
    if (shutdownCleanupPromise) return shutdownCleanupPromise;
    shutdownCleanupPromise = Promise.resolve()
      .then(async () => {
        if (typeof worker.sweepActiveDirtyWorktreesAsync !== "function") {
          return {
            ...emptyShutdownSweepSummary(),
            sweepFailed: true,
            error: "async dirty sweep unavailable",
          };
        }
        return worker.sweepActiveDirtyWorktreesAsync("shutdown-signal", {
          maxTotalMs: 2000,
          worktreeLockWaitMs: 250,
        });
      })
      .then((swept) => {
        shutdownSweepSummary = normalizeShutdownSweepSummary(swept);
        reportShutdownSweep(shutdownSweepSummary);
        return shutdownSweepSummary;
      })
      .catch((err) => {
        shutdownSweepSummary = {
          ...emptyShutdownSweepSummary(),
          sweepFailed: true,
          error: err?.message || String(err),
        };
        reportShutdownSweep(shutdownSweepSummary);
        return shutdownSweepSummary;
      });
    return shutdownCleanupPromise;
  };
  const messageCleanup = (msg) => { if (msg === "shutdown") cleanup(); };
  const cleanup = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      // Force exit on second Ctrl+C. Do not run DB/git cleanup on the signal
      // stack; the first Ctrl+C already queued lock release and cleanup.
      stopDisplaySnapshotCaches();
      if (display) display.stop();
      try { scheduler.requestStop?.(); } catch { /* best-effort */ }
      void cleanupAtlasForSession({ label: "Forced shutdown" });
      closeRuntimeStateForExit();
      process.exit(1);
    }

    if (shutdownInProgress) return;
    shutdownInProgress = true;
    worker.shuttingDown = true;
    shutdownForceExitTimer = setTimeout(() => {
      stopDisplaySnapshotCaches();
      if (display) display.stop();
      try { scheduler.requestStop?.(); } catch { /* best-effort */ }
      void cleanupAtlasForSession({ label: "Shutdown watchdog" });
      closeRuntimeStateForExit();
      process.exit(1);
    }, 45_000);
    shutdownForceExitTimer.unref?.();

    if (display) {
      display.cancelAllQuestions();
      display.addEvent(`${C.yellow}Graceful shutdown \u2014 killing workers, stashing work...${C.reset}`);
      display.addEvent(`${C.dim}(Ctrl+C again to force-exit)${C.reset}`);
      display.requestRender({ force: true });
    } else {
      console.log(`\n  ${C.yellow}Graceful shutdown \u2014 killing workers, stashing work...${C.reset}`);
      console.log(`  ${C.dim}(Ctrl+C again to force-exit)${C.reset}`);
    }

    // Kill all running workers so they can stash work and release leases
    const killed = worker.killAllJobs("shutdown");
    // Release the scheduler lock before best-effort local cleanup. The dirty
    // sweep may touch git/worktree locks, so both pieces are queued off the
    // signal handler stack.
    void scheduleSchedulerStop().then(() => startShutdownDirtySweep());
    if (display) {
      display.addEvent(`${C.dim}Sent kill to ${killed} worker(s)${C.reset}`);
      display.requestRender({ force: true });
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  // Windows: SIGTERM doesn't fire. SIGBREAK (Ctrl+Break) is the closest equivalent
  // for external shutdown signals. Also handle 'message' for PM2/child_process.
  if (process.platform === "win32") {
    process.on("SIGBREAK", cleanup);
    process.on("message", messageCleanup);
  }

  try {
    recordRunDiagnostic("scheduler.run_loop_starting", {
      owner_id: scheduler.ownerId || null,
      concurrency: CONCURRENCY,
    });
  } catch { /* observational */ }

  // Hold the Atlas conductor warm for the whole run so per-WI warms reuse one hot
  // ParseEngine. Released + disposed by cleanupAtlasForSession on every exit path.
  try { setConductorKeepWarm(true); } catch { /* best-effort */ }

  await scheduler.runLoop(
    (job) => worker.execute(job),
    {
      onJobStart: (job) => {
        if (display) {
          const role = displayRoleForJobType(job.job_type);
          // Strip redundant role prefix from title (e.g. "Research: Add JWT" → "Add JWT")
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
      },
      onJobEnd: (job) => {
        if (display) {
          const freshJob = getJob(job.id);
          display.removeWorker(job.id, freshJob?.status || "done");
        }
        const freshJob = getJob(job.id);
        if (freshJob?.status === "succeeded") {
          let hasMergeable = false;
          try {
            hasMergeable = typeof hasAutoMergeableCompletedWorkItems === "function"
              && hasAutoMergeableCompletedWorkItems();
          } catch {
            hasMergeable = false;
          }
          if (hasMergeable) {
            startIdleAutoMerge({
              reason: "job completion",
              runGc: false,
              afterMerged: (mergedCount) => {
                const mergedMsg = `Auto-merged ${mergedCount} completed work item${mergedCount === 1 ? "" : "s"} after job completion.`;
                if (display) display.addEvent(`${C.green}${mergedMsg}${C.reset}`);
                else console.log(`\n  ${C.green}${mergedMsg}${C.reset}`);
              },
              onError: (err) => {
                const errMsg = `Auto-merge after job completion failed: ${err?.message || err}`;
                if (display) display.addEvent(`${C.red}${errMsg}${C.reset}`);
                else console.log(`\n  ${C.red}${errMsg}${C.reset}`);
              },
            });
          }
        }
      },
      onIdle: (activeJobs) => {
        const pendingReviewBlocker = describePendingReviewLockBlockers();
        if (pendingReviewBlocker && pendingReviewBlocker !== lastPendingReviewBlockerMsg) {
          lastPendingReviewBlockerMsg = pendingReviewBlocker;
          if (autoMergePendingReviewBlockers && typeof autoMergeCompletedWorkItems === "function") {
            if (!idleAutoMergePromise && !pendingReviewAutoMergeAttempts.has(pendingReviewBlocker)) {
              pendingReviewAutoMergeAttempts.add(pendingReviewBlocker);
              startIdleAutoMerge({
                reason: "pending-review blocker",
                runGc: false,
                beforeStart: () => {
                  const msg = "Queued work is blocked by pending review; auto-merge is enabled, attempting merge.";
                  if (display) display.addEvent(`${C.cyan}${msg}${C.reset}`);
                  else console.log(`\n  ${C.cyan}${msg}${C.reset}`);
                },
                afterMerged: (mergedCount) => {
                  if (mergedCount > 0) {
                    lastPendingReviewBlockerMsg = null;
                    pendingReviewAutoMergeAttempts.clear();
                    const mergedMsg = `Auto-merged ${mergedCount} blocker work item${mergedCount === 1 ? "" : "s"}; queued work can continue.`;
                    if (display) display.addEvent(`${C.green}${mergedMsg}${C.reset}`);
                    else console.log(`\n  ${C.green}${mergedMsg}${C.reset}`);
                  }
                },
                afterNoMerge: () => {
                  if (display) display.addEvent(`${C.yellow}${pendingReviewBlocker}${C.reset}`);
                  else console.log(`\n  ${C.yellow}${pendingReviewBlocker}${C.reset}`);
                },
                onError: (err) => {
                  const errMsg = `Auto-merge for pending-review blocker failed: ${err?.message || err}`;
                  if (display) display.addEvent(`${C.red}${errMsg}${C.reset}`);
                  else console.log(`\n  ${C.red}${errMsg}${C.reset}`);
                  if (display) display.addEvent(`${C.yellow}${pendingReviewBlocker}${C.reset}`);
                  else console.log(`\n  ${C.yellow}${pendingReviewBlocker}${C.reset}`);
                },
              });
            }
          } else {
            if (display) display.addEvent(`${C.yellow}${pendingReviewBlocker}${C.reset}`);
            else console.log(`\n  ${C.yellow}${pendingReviewBlocker}${C.reset}`);
          }
        } else if (!pendingReviewBlocker) {
          startIdleAutoMerge({
            reason: "scheduler idle",
            runGc: false,
            afterMerged: (mergedCount) => {
              const mergedMsg = `Auto-merged ${mergedCount} completed work item${mergedCount === 1 ? "" : "s"} during scheduler idle.`;
              if (display) display.addEvent(`${C.green}${mergedMsg}${C.reset}`);
              else console.log(`\n  ${C.green}${mergedMsg}${C.reset}`);
            },
          });
        }
        const blocked = activeJobs.filter((j) => j.status === "blocked" || j.status === "waiting_on_human" || j.status === "waiting_on_review");
        if (blocked.length > 0 && blocked.length === activeJobs.length) {
          const msg = `All ${activeJobs.length} remaining job(s) are blocked/waiting.`;
          if (display) display.addEvent(`${C.yellow}${msg}${C.reset}`);
          else console.log(`\n  ${C.yellow}${msg}${C.reset}`);
        }
      },
      onDone: () => {
        const msg = "All jobs complete.";
        if (display) display.addEvent(`${C.green}${C.bold}${msg}${C.reset}`);
        else console.log(`\n  ${C.green}${C.bold}${msg}${C.reset}`);
      },
      onSlotStatus: ({ blockedByLock, blockedLockDetails = [] }) => {
        if (display) {
          display._blockedByLock = blockedByLock;
          display._blockedByLockDetails = blockedLockDetails;
        }
      },
      onKillJob: (jobId, reason) => worker.killJob(jobId, reason),
    },
  );
  try {
    recordRunDiagnostic("scheduler.run_loop_returned", {
      owner_id: scheduler.ownerId || null,
      shutdown_in_progress: !!shutdownInProgress,
    });
  } catch { /* observational */ }

  await waitForIdleAutoMerge();

  // ── Post-scheduler: clean up worktrees if shutdown was triggered ──
  if (shutdownInProgress) {
    emitCloseoutStatus("Graceful shutdown - run wrap-up: starting closeout.", C.yellow);
    if (schedulerStopPromise) await schedulerStopPromise;
    if (!shutdownCleanupPromise) startShutdownDirtySweep();
    if (shutdownCleanupPromise) {
      emitCloseoutStatus("Graceful shutdown - run wrap-up: finishing active worktree sweep...", C.cyan);
      await flushCloseoutStatus();
      await shutdownCleanupPromise;
    }
    if (needsGit) {
      emitCloseoutStatus("Graceful shutdown - run wrap-up: cleaning worktrees...", C.cyan);
      await flushCloseoutStatus();
      await startupWorktreeCleanup();
      emitCloseoutStatus("Graceful shutdown - run wrap-up: worktrees clean.", C.green);
    }
    await flushCloseoutStatus();
    await cleanupAtlasForSession({ label: "Graceful shutdown - run wrap-up" });
    await flushCloseoutStatus();
    emitCloseoutStatus("Graceful shutdown - run wrap-up: done.", C.green);
    await flushCloseoutStatus();
    if (shutdownForceExitTimer) {
      clearTimeout(shutdownForceExitTimer);
      shutdownForceExitTimer = null;
    }

    // Swap signal handlers and exit — skip interactive wrap-up after shutdown
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    if (process.platform === "win32") {
      process.off("SIGBREAK", cleanup);
      process.off("message", messageCleanup);
    }
    const hadDisplay = !!display;
    stopDisplaySnapshotCaches();
    if (display) display.stop();
    if (hadDisplay) console.log(`\n  ${C.green}Graceful shutdown complete.${C.reset}\n`);
    closeRuntimeStateForExit();
    process.exitCode = 0;
    exitProcess?.(0);
    return;
  }

  // Replace scheduler cleanup handler with a simpler one for the wrap-up phase.
  // The display is still in raw mode, so Ctrl+C is intercepted by keypress and
  // emitted as process.emit("SIGINT") — without a handler, nothing happens.
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  if (process.platform === "win32") {
    process.off("SIGBREAK", cleanup);
    process.off("message", messageCleanup);
  }
  const wrapUpSigintCleanup = () => handleWrapUpSignal({ signal: "SIGINT", display, cleanupAtlasForSession });
  const wrapUpSigtermCleanup = () => handleWrapUpSignal({ signal: "SIGTERM", display, cleanupAtlasForSession });
  process.on("SIGINT", wrapUpSigintCleanup);
  process.on("SIGTERM", wrapUpSigtermCleanup);

  // Auto-merge performs a defensive WI-status reconciliation before it scans
  // for mergeable branches, so stale active rows do not have to pass through
  // review just to be merged.

  try {
    let nextAction = null;
    if (display) {
      if (liveReviewPromise) {
        // The scheduler can drain and exit on its own while a live review is
        // still open. Wait for runLiveReview's closeout (merge-queue drain +
        // report save) so wrapUpTui doesn't re-enter approval mode over the
        // live session and strand its resolver.
        emitCloseoutStatus("Run wrap-up: waiting for the open review to finish.", C.cyan);
        await liveReviewPromise;
      }
      emitCloseoutStatus("Run wrap-up: starting closeout.", C.cyan);
      if (typeof display.setRunPhase === "function") display.setRunPhase("Run wrap-up");
      await flushCloseoutStatus();
      nextAction = await wrapUpTui(display);
    } else {
      emitCloseoutStatus("Run wrap-up: starting closeout.", C.cyan);
      nextAction = await wrapUp();
    }
    if (nextAction?.rerun) {
      stopDisplaySnapshotCaches();
      if (display) display.stop();
      await this.run();
      return;
    }
    emitCloseoutStatus("Run wrap-up: done.", C.green);
    await flushCloseoutStatus();
  } finally {
    // Ensure display is always stopped — some wrapUpTui paths missed this
    stopDisplaySnapshotCaches();
    if (display) display.stop();
    process.off("SIGINT", wrapUpSigintCleanup);
    process.off("SIGTERM", wrapUpSigtermCleanup);
    // Natural-completion exit: release + dispose the conductor so its worker
    // thread doesn't pin the loop (shutdown paths already do this via 3133).
    await cleanupAtlasForSession({ label: "Run wrap-up", announce: false });
  }

  }
}
