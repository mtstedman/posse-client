// Runtime session orchestration for the run command.
// Keeps the CLI entry point thin while preserving the existing command behavior.

import { ensureRemoteCatalogLoaded, getRemoteCatalog } from "../../providers/functions/model-catalog-store.js";
import { describeModelCatalogWarning, validateConfiguredModels } from "../../providers/functions/model-catalog-validate.js";
import { maybeRefreshModelCatalog } from "../../remote/functions/model-catalog-refresh.js";
import { cancelOpenPushOfferGates } from "../../queue/functions/push-offer.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import { setConductorKeepWarm, closeSharedConductor } from "../../atlas/functions/v2/parse/conductor.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { recordRunDiagnostic } from "../../../shared/telemetry/functions/run-diagnostics.js";
import { reconcileNativeBinaries } from "../../../shared/native/functions/binary-reconciliation.js";
import { ensureBootDependenciesInWorker, formatBootDependencySync } from "../../system/functions/dependency-sync.js";
import { repairMissingProviderDependencies, getProvidersNeedingDependencyRepair } from "../../providers/functions/provider.js";
import { DEFAULT_POSSE_ROOT } from "../../runtime/functions/python-runtime.js";
import { LOCK_HOLDING_JOB_STATUSES, PARKED_JOB_STATUSES } from "../../../catalog/job.js";
import { TERMINAL_WORK_ITEM_STATUSES, WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { parseWorkItemMetadata } from "../../planning/functions/state.js";
import { getResearchBudget } from "../../../shared/policies/functions/role-utils.js";
import { nativeBinaries as defaultNativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { daemonSupervisor as defaultDaemonSupervisor } from "../../../shared/tools/classes/daemon/index.js";
import { persistentMcpOwner as defaultPersistentMcpOwner } from "../../../shared/tools/classes/PersistentMcpOwner.js";
import { RunBootPanelController } from "./RunBootPanelController.js";
import { RunCloseoutController } from "./RunCloseoutController.js";
import { RunDisplayActions } from "./RunDisplayActions.js";
import { RunDisplaySnapshotController } from "./RunDisplaySnapshotController.js";
import { RunIdleAutoMergeController } from "./RunIdleAutoMergeController.js";
import { RunSchedulerLoopCallbacks } from "./RunSchedulerLoopCallbacks.js";
import { RunShutdownController } from "./RunShutdownController.js";
import {
  PROVIDER_AUTH_WARMUP_TIMEOUT_MS,
  PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS,
  closeRuntimeStateForExit,
  firstLine,
  handleWrapUpSignal,
  summarizeRunCompletion,
  bootScipLangPatchFromEvent,
  scopeScipEventToSourceLanguage,
} from "../functions/run-session.js";
import {
  checkPosseUpdateAvailabilityCached,
  formatPosseUpdateAvailableWarning,
} from "../functions/update-command.js";
import { createRunWrapUpTracker } from "../functions/review-session.js";
import { BossyLocalStream } from "../../bridge/classes/BossyLocalStream.js";

const OPEN_WORK_ITEM_STATUSES = Object.freeze(
  WORK_ITEM_STATUSES.filter((status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status)),
);

function formatNativeDownloadMiB(bytes) {
  const value = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function summarizeNativeArtifactResults(results) {
  const unavailable = results.filter((result) => result?.ok !== true);
  const downloaded = results.filter((result) => result?.downloaded).length;
  return {
    unavailable,
    downloaded,
    detail: unavailable.length > 0
      ? `${results.length - unavailable.length}/${results.length} ready; unavailable: ${unavailable.map((result) => result.name).join(", ")}`
      : `${results.length} ready${downloaded > 0 ? `; ${downloaded} downloaded` : ""}`,
  };
}

export class RunSession {
  constructor(deps = {}) {
    Object.assign(this, deps);
    this._activeWorker = null;
    this._activeScheduler = null;
    this._stoppedSchedulers = new WeakSet();
    this._activeShutdown = null;
    this._activeDisplay = null;
    this._removeRunSignalHandlers = null;
    this._stopRunDisplaySnapshots = null;
    this._cleanupRunAtlas = null;
    this._bossyLocalStream = null;
    this._processResourceDisposal = null;
  }

  async run() {
    try {
      return await this.#run();
    } finally {
      await this.#disposeRunResources();
    }
  }

  async #disposeRunResources() {
    await this.#disposeIterationResources();
    await this.#disposeProcessResources();
  }

  async #disposeIterationResources() {
    const shutdown = this._activeShutdown;
    this._activeShutdown = null;
    try { shutdown?.uninstall?.(); } catch { /* best effort */ }
    const removeSignalHandlers = this._removeRunSignalHandlers;
    this._removeRunSignalHandlers = null;
    try { removeSignalHandlers?.(); } catch { /* best effort */ }
    const scheduler = this._activeScheduler;
    try { this.#stopScheduler(scheduler); } catch { /* best effort */ }
    const bossyLocalStream = this._bossyLocalStream;
    this._bossyLocalStream = null;
    try { await bossyLocalStream?.close?.(); } catch { /* best effort */ }
    const stopDisplaySnapshots = this._stopRunDisplaySnapshots;
    this._stopRunDisplaySnapshots = null;
    try { stopDisplaySnapshots?.(); } catch { /* best effort */ }
    const display = this._activeDisplay;
    this._activeDisplay = null;
    try { display?.stop?.(); } catch { /* best effort */ }

    const worker = this._activeWorker;
    this._activeWorker = null;
    const cleanupAtlas = this._cleanupRunAtlas;
    this._cleanupRunAtlas = null;
    try { await cleanupAtlas?.({ label: "Run cleanup", announce: false }); } catch { /* best effort */ }
    try { await worker?.disposeAgents?.("run_session_exit"); } catch { /* best effort */ }
  }

  #stopScheduler(scheduler) {
    if (!scheduler || this._stoppedSchedulers.has(scheduler)) return;
    this._stoppedSchedulers.add(scheduler);
    try {
      scheduler.stop?.();
      if (this._activeScheduler === scheduler) this._activeScheduler = null;
    } catch (err) {
      this._stoppedSchedulers.delete(scheduler);
      throw err;
    }
  }

  async #disposeProcessResources() {
    if (!this._processResourceDisposal) {
      this._processResourceDisposal = (async () => {
        try { await (this.daemonSupervisor || defaultDaemonSupervisor)?.shutdownAll?.(); } catch { /* best effort */ }
        try { await (this.persistentMcpOwner || defaultPersistentMcpOwner)?.close?.({ force: true }); } catch { /* best effort */ }
        try { await (this.nativeBinaries || defaultNativeBinaries)?.disposeAll?.(); } catch { /* best effort */ }
      })();
    }
    await this._processResourceDisposal;
  }

  async #run() {
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
      checkPosseUpdateAvailability: checkPosseUpdateAvailabilityForRun = checkPosseUpdateAvailabilityCached,
      formatPosseUpdateAvailableWarning: formatPosseUpdateAvailableWarningForRun = formatPosseUpdateAvailableWarning,
      ensureBootDependenciesInWorker: runBootDependencySync = ensureBootDependenciesInWorker,
      formatBootDependencySync: formatBootDependencySyncForRun = formatBootDependencySync,
      repairMissingProviderDependencies: repairMissingProviderDependenciesForRun = repairMissingProviderDependencies,
      getProvidersNeedingDependencyRepair: getProvidersNeedingDependencyRepairForRun = getProvidersNeedingDependencyRepair,
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
      disableAtlasForRun,
      isAtlasRuntimeDisabled,
      getAtlasRuntimeDisabledReason,
      enqueueAtlasSelfRepair,
      setConductorKeepWarm: setConductorKeepWarmForRun = setConductorKeepWarm,
      closeSharedConductor: closeSharedConductorForRun = closeSharedConductor,
      nativeBinaries: nativeBinariesForRun = defaultNativeBinaries,
      daemonSupervisor: daemonSupervisorForRun = defaultDaemonSupervisor,
      persistentMcpOwner: persistentMcpOwnerForRun = defaultPersistentMcpOwner,
      log,
      Display,
      STALL_TIMEOUT,
      Worker,
      AUTO_APPROVE,
      DRY_RUN,
      nonInteractive = false,
      RUN_WORK_ITEM_IDS = [],
      requeueForShutdown,
      requeueWaitingHumanInputJobs,
      reconcileMergedWorkItemReviewStates,
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
      listJobsByWorkItem,
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
  let scheduler = null;
  let worker = null;
  const displaySnapshots = new RunDisplaySnapshotController({
    getDisplay: () => display,
    projectDir: PROJECT_DIR,
    log,
    collectDirtyStateAsync,
    getToolInvocationCountsByJob,
    getRecentToolInvocations,
    listActiveFileLocks,
  });
  const stopDisplaySnapshotCaches = () => displaySnapshots.stop();
  this._stopRunDisplaySnapshots = stopDisplaySnapshotCaches;
  const refreshDisplaySnapshotsForQueue = () => displaySnapshots.refreshForQueue();
  const setupDisplaySnapshotCaches = () => displaySnapshots.setup();

  const closeout = new RunCloseoutController({
    getDisplay: () => display,
    getScheduler: () => scheduler,
    getWorker: () => worker,
    C,
    log,
    projectDir: PROJECT_DIR,
    listJobs,
    startupWorktreeCleanup,
    isAtlasRuntimeDisabled,
    getAtlasRuntimeDisabledReason,
    setConductorKeepWarm: setConductorKeepWarmForRun,
    closeSharedConductor: closeSharedConductorForRun,
  });
  const emitCloseoutStatus = (message, color = C.dim) => closeout.emitStatus(message, color);
  const flushCloseoutStatus = () => closeout.flushStatus();
  const cleanupAtlasForSession = (opts) => closeout.cleanupAtlasForSession(opts);
  this._cleanupRunAtlas = cleanupAtlasForSession;
  const drainPendingAtlasWarmJobs = (opts) => closeout.drainPendingAtlasWarmJobs(opts);
  const runBoundedCloseoutWorktreeCleanup = (opts) => closeout.runBoundedCloseoutWorktreeCleanup(opts);
  const cleanupResidualWorktreesAfterAtlas = (opts) => closeout.cleanupResidualWorktreesAfterAtlas(opts);

  let schedulerStopPromise = null;
  const scheduleSchedulerStop = () => {
    try { scheduler.requestStop?.(); } catch { /* best-effort */ }
    if (schedulerStopPromise) return schedulerStopPromise;
    schedulerStopPromise = new Promise((resolve) => {
      const finish = () => {
        try { this.#stopScheduler(scheduler); } catch { /* best-effort */ }
        resolve();
      };
      if (typeof setImmediate === "function") setImmediate(finish);
      else setTimeout(finish, 0);
    });
    return schedulerStopPromise;
  };

  const scopedWorkItemIds = Array.isArray(RUN_WORK_ITEM_IDS)
    ? RUN_WORK_ITEM_IDS.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  const scopedWorkItemIdSet = new Set(scopedWorkItemIds);
  const isScopedRun = scopedWorkItemIdSet.size > 0;
  const refreshRunVisibleWorkItems = () => {
    if (typeof refreshWorkItemStatus !== "function") return;
    const items = isScopedRun
      ? scopedWorkItemIds.map((id) => getWorkItem(id)).filter(Boolean)
      : listWorkItems(OPEN_WORK_ITEM_STATUSES);
    for (const item of items) {
      if (!item?.id || TERMINAL_WORK_ITEM_STATUSES.includes(item.status)) continue;
      try { refreshWorkItemStatus(item.id); } catch { /* best-effort status repair before run selection */ }
    }
  };
  const describeScopedWorkItems = () => scopedWorkItemIds
    .map((id) => getWorkItem(id))
    .filter(Boolean)
    .map((item) => `WI#${item.id} ${item.status}`)
    .join(", ");
  const seedInitialJobsForBootWorkItems = (items, source) => {
    let created = 0;
    for (const item of items) {
      const status = String(item?.status || "").toLowerCase();
      if (status !== "queued" && status !== "planning") continue;
      const existingJobs = typeof listJobsByWorkItem === "function" ? listJobsByWorkItem(item.id) : [];
      if (Array.isArray(existingJobs) && existingJobs.length > 0) continue;
      const deepthinkBudget = getResearchBudget(item);
      const metadata = parseWorkItemMetadata(item);
      createInitialResearchOrPlanJob(item, {
        deepthinkBudget,
        deepthinkBudgetExplicit: metadata.research_budget_explicit === true,
        source,
        redTeamPlan: shouldUseRedTeamPlanForWorkItem(item),
        routing: classifyResearchForRouting({ workItem: item, source, live: true }),
      });
      const freshStatus = String(getWorkItem(item.id)?.status || status).toLowerCase();
      if (freshStatus === "queued") updateWorkItemStatus(item.id, "planning");
      created += 1;
    }
    return created;
  };
  try { reconcileMergedWorkItemReviewStates?.(); } catch { /* best-effort repair of legacy merged review rows */ }
  refreshRunVisibleWorkItems();
  const seedableRunItems = isScopedRun
    ? scopedWorkItemIds.map((id) => getWorkItem(id)).filter(Boolean)
    : listWorkItems(["queued", "planning"]);
  seedInitialJobsForBootWorkItems(seedableRunItems, isScopedRun ? "run_scoped" : "run");
  maybeAnnounceAutoMergeSetting();
  const allCandidateJobs = listJobs(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
  const jobs = isScopedRun
    ? allCandidateJobs.filter((job) => scopedWorkItemIdSet.has(Number(job.work_item_id)))
    : allCandidateJobs;
  const needsGit = jobsNeedGitWorktree(jobs);
  const parkedStatusSet = new Set(PARKED_JOB_STATUSES);
  const parkedJobs = jobs.filter((job) => parkedStatusSet.has(job.status));
  const runnableOrActiveJobs = jobs.filter((job) => !parkedStatusSet.has(job.status));
  const refreshNativeArtifacts = async ({ onDownloadProgress = null } = {}) => {
    if (typeof nativeBinariesForRun?.ensureAvailable !== "function") return [];
    return reconcileNativeBinaries({
      manager: nativeBinariesForRun,
      refresh: true,
      onDownloadProgress,
    });
  };
  const sessionCountLabel = () => {
    const parts = [`${runnableOrActiveJobs.length} runnable/active job(s)`];
    if (parkedJobs.length > 0) parts.push(`${parkedJobs.length} parked/waiting`);
    return parts.join(", ");
  };
  // Headless idle/parked runs return before the panel-driven boot phase below.
  // Reconcile issued artifacts here so unattended invocations do not leave the
  // installation on stale binaries merely because no scheduler work can run.
  if (!useTui && runnableOrActiveJobs.length === 0) {
    const results = await refreshNativeArtifacts();
    if (results.length > 0) {
      const summary = summarizeNativeArtifactResults(results);
      const color = summary.unavailable.length > 0 ? C.yellow : C.dim;
      console.log(`  ${color}Native binaries: ${summary.detail}${C.reset}`);
    }
  }
  if (runnableOrActiveJobs.length === 0 && parkedJobs.length > 0 && !useTui) {
    console.log(`\n  ${C.yellow}No runnable jobs. ${parkedJobs.length} parked/waiting job(s) need the TUI or operator action before work can continue.${C.reset}\n`);
    process.exitCode = summarizeRunCompletion(
      [...new Set(parkedJobs.map((job) => Number(job.work_item_id)))]
        .map((id) => getWorkItem(id))
        .filter(Boolean),
    ).exitCode;
    return;
  }

  if (jobs.length === 0) {
    if (isScopedRun) {
      const scopedSummary = describeScopedWorkItems();
      const suffix = scopedSummary ? ` (${scopedSummary})` : "";
      console.log(`\n  No runnable jobs for scoped work item(s): ${scopedWorkItemIds.join(", ")}${suffix}.\n`);
      process.exitCode = summarizeRunCompletion(
        scopedWorkItemIds.map((id) => getWorkItem(id)).filter(Boolean),
      ).exitCode;
      return;
    }
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
      console.log(`\n  ${C.bold}No runnable jobs — ${reviewable.length} work item(s) ready for review.${C.reset}\n`);
      await cmdReview();
      return;
    }
    if (autoMergedNow > 0) {
      await offerPush?.(autoMergedNow);
      return;
    }
    const openWorkItems = listWorkItems(OPEN_WORK_ITEM_STATUSES);
    if (openWorkItems.length > 0) {
      const summary = openWorkItems
        .slice(0, 5)
        .map((item) => `WI#${item.id} ${item.status}`)
        .join(", ");
      const more = openWorkItems.length > 5 ? `, +${openWorkItems.length - 5} more` : "";
      console.log(`\n  No runnable jobs. ${openWorkItems.length} open work item(s) are parked or blocked: ${summary}${more}.\n`);
      process.exitCode = summarizeRunCompletion(openWorkItems).exitCode;
      return;
    }
    console.log(`\n  No runnable jobs. Use 'plan' to create jobs from queued items.\n`);
    return;
  }

  // First-run git initialization, identity prompts, and the bootstrap commit
  // must happen on plain stdout before the session banner and boot panel/TUI.
  if (typeof ensureRepoSetupConfirmed === "function" && !(await ensureRepoSetupConfirmed())) {
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
    console.log(`\n  ${C.green}${C.bold}Resuming session${C.reset}${C.green}: ${sessionCountLabel()} (concurrency: ${CONCURRENCY})${isScopedRun ? ` scoped to WI#${scopedWorkItemIds.join(", WI#")}` : ""}${C.reset}`);
    if (wiWithBranch.length > 0)
      console.log(`  ${C.cyan}Rejoining ${wiWithBranch.length} worktree(s)${C.reset}`);
    if (stallResume.length > 0)
      console.log(`  ${C.yellow}${stallResume.length} job(s) will resume from stash${C.reset}`);
    if (resumed.length > 0)
      console.log(`  ${C.yellow}${resumed.length} previously in-flight job(s) requeued${C.reset}`);
    console.log();
  } else {
    console.log(`\n  ${C.bold}New session: ${sessionCountLabel()} (concurrency: ${CONCURRENCY})${isScopedRun ? ` scoped to WI#${scopedWorkItemIds.join(", WI#")}` : ""}${C.reset}`);
    console.log();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Boot panel — single instance, spans the entire boot lifecycle until the
  // alt-screen TUI attaches. The controller owns terminal rendering, provider
  // chips, language matrix state, boot input, and runtime-status mirroring.
  // ════════════════════════════════════════════════════════════════════════
  const boot = new RunBootPanelController({
    C,
    log,
    getDisplay: () => display,
  });
  const bootAbortController = boot.abortController;
  const bootPanel = boot.bootPanel;
  const bootSteps = boot.bootSteps;
  const TERMINAL_BOOT_LANG_STATES = boot.terminalLangStates;
  const updateBootStep = (label, patch = {}) => boot.updateStep(label, patch);
  const updateProviderBootStep = (label, patch = {}) => boot.updateProviderStep(label, patch);
  const normalizeProviderStepName = (value) => boot.normalizeProviderStepName(value);
  const providerStatusFromHealth = (status) => boot.providerStatusFromHealth(status);
  const finalizeRunningProviderBootSteps = (status, detail = "") => boot.finalizeRunningProviderSteps(status, detail);
  const updateBootLang = (language, side, patch = {}) => boot.updateLang(language, side, patch);
  const matrixLanguages = { add: (language) => boot.addMatrixLanguage(language) };
  const setBootEnterAction = (handler = null) => boot.setEnterAction(handler);
  const updateBootFooter = (text) => boot.updateFooter(text);
  const updateBootAtlasNotice = (text) => boot.updateAtlasNotice(text);
  const bootCanPromptForBackground = () => boot.canPromptForBackground();
  const stopBootMonitor = (opts) => boot.stop(opts);
  const handleSchedulerBootEvent = (event = {}) => boot.handleSchedulerBootEvent(event);
  const requestAtlasBootBackground = (reason = "user-enter") => {
    if (atlasBootBackgroundRequested) return;
    atlasBootBackgroundRequested = true;
    atlasBootBackgroundReason = reason;
    log?.info?.("atlas", "ATLAS boot wait released to background", { reason });
    updateBootFooter("ATLAS/ONNX loading in background; entering the TUI...");
    setBootEnterAction(null);
    try { resolveAtlasBootBackgroundRequest?.({ kind: "background", reason }); } catch { /* best effort */ }
  };
  // ── Boot phase (panel-driven; alt-screen TUI takes over after display.start)
  // The TUI alt-screen buffer hides anything printed before display.stop(),
  // so all prompts, prerequisite checks, orphan recovery, provider health,
  // and ATLAS indexing run BEFORE we attach the display. Each phase routes
  // through updateBootStep so the boot panel shows a single coherent view
  // instead of a stream of `Boot: …` log lines.

  // Paint the full boot checklist up front so the sections are visible from
  // the start and fill in as each step runs.
  boot.seedChecklist();

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

  // ── Provider dependency self-heal (OFF the critical path) ──────────────────
  // A provider whose optional SDK lost a transitive shim dep — the recurring
  // case is the openai SDK's `agentkeepalive`, which npm prune/partial-installs
  // intermittently drop — fails to LOAD and paints a hard ✗ "needs attn" chip
  // on EVERY boot, because the boot dependency check is dryRun and never repairs
  // it. Detect that ONE recoverable condition (ERR_MODULE_NOT_FOUND) and run a
  // scoped, node-only install against the posse install root in the background;
  // on success the provider module is re-imported in-process and the chip flips
  // ✗ → ✓ with no restart. Never blocks boot; the abort signal tears it down.
  const providersNeedingRepair = typeof getProvidersNeedingDependencyRepairForRun === "function"
    ? (getProvidersNeedingDependencyRepairForRun() || [])
    : [];
  if (providersNeedingRepair.length > 0 && typeof repairMissingProviderDependenciesForRun === "function") {
    for (const name of providersNeedingRepair) {
      updateProviderBootStep(name, { status: "running", detail: "installing missing dependency", force: true });
    }
    void (async () => {
      try {
        const result = await repairMissingProviderDependenciesForRun({
          signal: bootAbortController.signal,
          runNodeDependencySync: ({ signal, forceNodeInstall = false } = {}) => runBootDependencySync({
            // Target the posse INSTALL root (where the provider modules resolve
            // their node_modules), node-only — no SCIP/python/composer/native
            // probes, and NOT dryRun: this is the repair the boot check skips.
            projectDir: DEFAULT_POSSE_ROOT,
            posseRoot: DEFAULT_POSSE_ROOT,
            includePython: false,
            includeComposer: false,
            includeGo: false,
            includeCargo: false,
            includeScip: false,
            includeTestTools: false,
            dryRun: false,
            forceNodeInstall,
          }, {
            signal,
            onProgress: (event = {}) => {
              const msg = firstLine(event.message || "");
              if (!msg) return;
              for (const name of providersNeedingRepair) {
                updateProviderBootStep(name, { status: "running", detail: msg, showDetail: true, force: true });
              }
            },
          }),
        });
        // Repaint each repaired provider from its now-live health row.
        const healthByName = new Map();
        if (typeof getProviderHealth === "function") {
          for (const row of getProviderHealth() || []) {
            healthByName.set(normalizeProviderStepName(row?.provider || row?.name), row);
          }
        }
        for (const name of result.repaired) {
          const row = healthByName.get(normalizeProviderStepName(name));
          updateProviderBootStep(name, {
            status: row ? providerStatusFromHealth(row.status) : "ok",
            detail: row?.detail || "",
            force: true,
          });
        }
        for (const name of result.stillBroken) {
          const row = healthByName.get(normalizeProviderStepName(name));
          updateProviderBootStep(name, {
            status: "failed",
            detail: firstLine(row?.detail || "dependency still missing"),
            showDetail: true,
            force: true,
          });
        }
        if (result.repaired.length > 0) {
          log?.info?.("run", "Provider dependency self-heal repaired providers", { providers: result.repaired });
        }
        if (result.stillBroken.length > 0) {
          log?.warn?.("run", "Provider dependency self-heal incomplete", {
            providers: result.stillBroken,
            install: firstLine(result.install?.error || ""),
          });
        }
      } catch (err) {
        log?.warn?.("run", "Provider dependency self-heal failed", { error: firstLine(err?.message || err) });
      }
    })();
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
    if (boot.hasProviderStep("claude")) {
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
  updateBootStep("repo setup", { section: "scheduler", status: "ok", force: true });

  // The dependency CHECK is advisory and must NOT gate boot. It is check-only
  // (dryRun) and nothing downstream consumes its result — it only paints the
  // "dependencies" chip. Awaiting it here used to block the whole boot; starting
  // it before git/worktree probes can also starve short native git budgets on
  // Windows. Launch it in the background after the git-critical DAG below.
  const startBootDependencyCheck = () => {
    updateBootStep("dependencies", { section: "workspace", status: "running", detail: "checking packages", force: true });
    void (async () => {
    try {
      const dependencyConfig = typeof getAtlasIntegrationConfig === "function"
        ? getAtlasIntegrationConfig()
        : null;
      // CHECK-ONLY at boot (dryRun): probe for managed indexer + package presence
      // but NEVER install on the critical path. Installs — especially `rustup
      // component add rust-analyzer`, a multi-minute network download — previously
      // ran here before the lock and ATLAS, freezing the whole boot for minutes.
      // Anything missing is now a non-fatal warning that points at `posse doctor`
      // (which runs the same checks in install mode); SCIP generation already
      // degrades gracefully when an indexer is absent (the language is skipped
      // this warm and caught up once the indexer is installed).
      const dependencyResult = await runBootDependencySync({
        projectDir: PROJECT_DIR,
        dryRun: true,
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
      const depCounts = dependencyResult?.counts || {};
      const depNeedsInstall = (depCounts.dry_run || 0) + (depCounts.failed || 0);
      updateBootStep("dependencies", {
        section: "workspace",
        status: depNeedsInstall > 0 ? "warning" : "ok",
        detail: depNeedsInstall > 0
          ? `${formatBootDependencySyncForRun(dependencyResult)} — run "posse doctor" to install`
          : formatBootDependencySyncForRun(dependencyResult),
        showDetail: depNeedsInstall > 0,
        force: true,
      });
    } catch (err) {
      // The boot dependency CHECK never blocks the run: a probe error degrades to
      // a warning row rather than aborting boot. Deterministic indexing and the
      // rest of boot do not depend on these installs, so the run proceeds and the
      // operator can repair with `posse doctor`.
      updateBootStep("dependencies", {
        section: "workspace",
        status: "warning",
        detail: `dependency check skipped: ${firstLine(err?.message || String(err))} — run "posse doctor"`,
        showDetail: true,
        force: true,
      });
    }
    })();
  };

  // Native refresh, Git readiness, and the cached client update check can run
  // together after repo setup. Required daemon startup waits for both native
  // artifact and Git readiness passes: either can include process/native probes
  // that stall the event loop long enough to exhaust an in-flight pulse handshake.
  const nativeArtifactTask = (async () => {
    if (typeof nativeBinariesForRun?.ensureAvailable !== "function") {
    updateBootStep("native binaries", {
        section: "workspace",
        status: "skipped",
        detail: "native manager unavailable",
        force: true,
      });
      return [];
    }
      updateBootStep("native binaries", {
      section: "workspace",
      status: "running",
      detail: "checking native artifacts",
      force: true,
    });
    const nativeArtifactResults = await refreshNativeArtifacts({
      onDownloadProgress: (progress) => {
        const active = progress.currentPackage || progress.currentName || "native artifacts";
        const activeLabel = progress.activeCount > 1
          ? `${active} (+${progress.activeCount - 1})`
          : active;
        const bytes = progress.totalBytes == null
          ? `${formatNativeDownloadMiB(progress.loadedBytes)} MB · sizing total`
          : `${formatNativeDownloadMiB(progress.loadedBytes)}/${formatNativeDownloadMiB(progress.totalBytes)} MB`;
        updateBootStep("native binaries", {
          section: "workspace",
          status: "running",
          activity: "download",
          detail: `${activeLabel} · ${bytes}`,
          percent: progress.percent,
        });
      },
    });
    if (nativeArtifactResults.length === 0) {
      updateBootStep("native binaries", {
        section: "workspace",
        status: "skipped",
        detail: "no enabled native binaries",
        force: true,
      });
      return nativeArtifactResults;
    }
    const summary = summarizeNativeArtifactResults(nativeArtifactResults);
    updateBootStep("native binaries", {
      section: "workspace",
      status: summary.unavailable.length > 0 ? "warning" : "ok",
      detail: summary.detail,
      showDetail: summary.unavailable.length > 0,
      force: true,
    });
    return nativeArtifactResults;
  })();

  // CACHED check (6h TTL): a warm cache answers from disk without touching the
  // network. A stale check is soft-bounded and continues detached so the next
  // boot can consume its refreshed cache.
  const updateCheckTask = (async () => {
    updateBootStep("posse update", { section: "workspace", status: "running", detail: "checking client", force: true });
    try {
      const updateCheck = await Promise.race([
        checkPosseUpdateAvailabilityForRun({ timeoutMs: 2_000 }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, skipped: "timeout" }), 1_000);
          timer.unref?.();
        }),
      ]);
      if (updateCheck?.available) {
        updateBootStep("posse update", {
          section: "workspace",
          status: "warning",
          detail: formatPosseUpdateAvailableWarningForRun(updateCheck),
          showDetail: true,
          force: true,
        });
      } else {
        updateBootStep("posse update", {
          section: "workspace",
          status: updateCheck?.ok ? "ok" : "skipped",
          force: true,
        });
      }
    } catch {
      updateBootStep("posse update", { section: "workspace", status: "skipped", force: true });
    }
  })();

  // Git readiness starts beside artifact refresh, but must settle before the
  // Atlas/vector pulse handshakes begin. It joins the in-flight Git artifact
  // refresh above.
  const gitReadyTask = (async () => {
    updateBootStep("git ready", { section: "workspace", status: "running", detail: "starting git", force: true });
    try {
      await ensureGitReady();
      updateBootStep("git ready", { section: "workspace", status: "ok", force: true });
      return { ok: true, error: null };
    } catch (error) {
      updateBootStep("git ready", {
        section: "workspace",
        status: needsGit ? "failed" : "skipped",
        detail: firstLine(error?.message || "git unavailable"),
        showDetail: true,
        force: true,
      });
      return { ok: false, error };
    }
  })();

  const nativeDaemonTask = (async () => {
    await Promise.all([nativeArtifactTask, gitReadyTask]);
    if (typeof nativeBinariesForRun?.ensureRequiredAtlasBinariesActive !== "function") {
      updateBootStep("starting daemons", {
        section: "workspace",
        status: "skipped",
        detail: "no required native daemons",
        force: true,
      });
      return [];
    }
    updateBootStep("starting daemons", {
      section: "workspace",
      status: "running",
      detail: "starting daemons: atlas + vector",
      force: true,
    });
    try {
      const required = await nativeBinariesForRun.ensureRequiredAtlasBinariesActive();
      updateBootStep("starting daemons", {
        section: "workspace",
        status: "ok",
        detail: `${required.map((result) => result.name).join(" + ")} active`,
        force: true,
      });
      return required;
    } catch (error) {
      updateBootStep("starting daemons", {
        section: "workspace",
        status: "failed",
        detail: firstLine(error?.message || error),
        showDetail: true,
        force: true,
      });
      throw error;
    }
  })();

  const [nativeArtifactsSettled, nativeDaemonsSettled, , gitReadySettled] = await Promise.allSettled([
    nativeArtifactTask,
    nativeDaemonTask,
    updateCheckTask,
    gitReadyTask,
  ]);
  if (nativeArtifactsSettled.status === "rejected" || nativeDaemonsSettled.status === "rejected") {
    // Tear the panel down + release the stdout intercept before rethrowing,
    // matching the git/dirty-tree/worktree failure paths below. Without this
    // the fatal message from the top-level CLI catch lands in the intercept
    // buffer and the process exits silently behind a frozen boot panel.
    try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    if (nativeArtifactsSettled.status === "rejected") throw nativeArtifactsSettled.reason;
    throw nativeDaemonsSettled.reason;
  }
  const gitReadyResult = gitReadySettled.status === "fulfilled"
    ? gitReadySettled.value
    : { ok: false, error: gitReadySettled.reason };
  if (!gitReadyResult.ok && needsGit) {
    try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    throw gitReadyResult.error;
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

  startBootDependencyCheck();

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
  scheduler = new Scheduler({
    concurrency: CONCURRENCY,
    hasDisplay: useTui,
    onQueueSnapshot: handleQueueSnapshot,
    onlyWorkItemIds: scopedWorkItemIds,
  });
  this._activeScheduler = scheduler;

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
  const idleAutoMerge = new RunIdleAutoMergeController({
    getDisplay: () => display,
    useTui,
    C,
    autoMergePendingReviewBlockers,
    autoMergeCompletedWorkItems,
  });

  // Pre-loop hook runs during scheduler.boot() — display is still null at that
  // point so all output routes to console.log (plain stdout, pre-TUI). The
  // panel + render helpers live in outer run-session scope (above) so they
  // span the entire boot lifecycle, not just pre-loop. This closure only
  // owns warmup-specific render state.
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
      let atlasEncodeStartedAt = null;
      let bootEncodeProgress = null;
      // Tree-derived/compression refresh inside the view build ("tree" stage).
      // Terminal means a status:"ok"/"failed" event already painted the bar —
      // the boot-end sweep must not overwrite a failed tree row with "done".
      let atlasTreeStarted = false;
      let atlasTreeTerminal = false;
      // The ML reseed reopens the tree bar; a failed deterministic tree build
      // must stay visibly failed instead of being repainted "building"/"done".
      let atlasTreeFailed = false;
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
      const formatBootCount = (value) => {
        if (value == null || value === "") return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      };
      const formatBootEta = (ms) => {
        const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const remainder = minutes % 60;
        return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
      };
      const renderEncodeBootActivity = (event = {}) => {
        atlasEncodeStarted = true;
        if (atlasEncodeStartedAt == null) atlasEncodeStartedAt = Date.now();
        const current = Number(event.progress_current ?? event.current ?? bootEncodeProgress?.current);
        const total = Number(event.progress_total ?? event.total ?? bootEncodeProgress?.total);
        const progressUnit = String(
          event.progress_unit ?? event.unit ?? bootEncodeProgress?.unit ?? "symbols",
        ).trim().toLowerCase() || "symbols";
        const rawPercent = Number(event.percent ?? bootEncodeProgress?.percent);
        const hasCount = Number.isFinite(current) && Number.isFinite(total) && total > 0;
        const percent = Number.isFinite(rawPercent)
          ? Math.max(0, Math.min(100, rawPercent))
          : (hasCount ? Math.max(0, Math.min(100, (current / total) * 100)) : null);
        const elapsedMs = atlasEncodeStartedAt == null ? 0 : Date.now() - atlasEncodeStartedAt;
        const eta = hasCount && current > 0 && current < total
          ? formatBootEta((elapsedMs / current) * (total - current))
          : null;
        const unitLabel = progressUnit === "documents" || progressUnit === "document"
          ? "documents"
          : progressUnit === "texts" || progressUnit === "text"
            ? "texts"
            : "symbols";
        const countDetail = hasCount
          ? `${formatBootCount(current)}/${formatBootCount(total)} ${unitLabel}`
          : firstLine(event.detail || event.text || bootEncodeProgress?.detail || "encoding");
        const phase = String(event.nativePhase || event.phase || "").trim().replace(/_/g, " ");
        const indexedSymbols = formatBootCount(event.indexedSymbols);
        const nativeCurrent = formatBootCount(event.nativeCurrent);
        const nativeTotal = formatBootCount(event.nativeTotal);
        const nativeUnit = String(event.nativeUnit || "texts").trim();
        const nativeBatchCurrent = formatBootCount(event.nativeBatchCurrent);
        const nativeBatchTotal = formatBootCount(event.nativeBatchTotal);
        const activity = [];
        if (unitLabel === "documents" && indexedSymbols != null) activity.push(`${indexedSymbols} symbols`);
        if (phase) activity.push(phase);
        if (nativeCurrent != null && nativeTotal != null) activity.push(`${nativeCurrent}/${nativeTotal} ${nativeUnit}`);
        if (nativeBatchCurrent != null && nativeBatchTotal != null) {
          activity.push(`native batch ${nativeBatchCurrent}/${nativeBatchTotal}`);
        }
        if (eta) activity.push(`~${eta} left`);
        const detail = [countDetail, ...activity].filter(Boolean).join(" · ");
        bootEncodeProgress = {
          current: hasCount ? current : null,
          total: hasCount ? total : null,
          percent,
          detail,
          unit: progressUnit,
        };
        bootPanel.updateEncode({
          state: "building",
          percent,
          detail,
        });
        if (!atlasBootBackgroundRequested) {
          // Encoding starts only after SCIP intake + view merge have landed, so
          // this is the "SCIP + views ready" point — the embedding/ONNX layer is
          // now warming. Hold boot here so the user can watch it warm, with Enter
          // to drop it to the background at any point during the encode. A
          // headless/non-interactive boot can't take that keypress, so it
          // releases immediately and keeps encoding behind the run loop.
          if (bootCanPromptForBackground()) {
            setBootEnterAction(() => requestAtlasBootBackground("enter"));
            updateBootFooter("hit Enter to load ONNX in the background");
          } else {
            requestAtlasBootBackground("non-interactive-views-ready");
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
          if (event?.kind === "atlas.index_notice" || event?.kind === "atlas.cold_index") {
            const notice = firstLine(event.text || event.detail || "");
            const noticeDetail = firstLine(event.noticeDetail || "");
            const noticeLines = [notice, noticeDetail].filter(Boolean);
            if (noticeLines.length > 0) updateBootAtlasNotice(noticeLines);
          }
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
                  renderEncodeBootActivity(event);
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
          // The tree-compression ML reseed runs AFTER encode, inside the warm:
          // a provider model pass labeling repo areas, minutes-long with no
          // percent stream. Without a bar it reads as a boot hang at 100% —
          // reopen the tree bar (it IS tree work) and refresh the footer so
          // the operator can see it and background it.
          if (String(event.stage || "") === "tree-compression") {
            atlasTreeStarted = true;
            if (!atlasTreeFailed) {
              atlasTreeTerminal = false;
              bootPanel.updateTree({
                state: "building",
                percent: null,
                detail: firstLine(event.text || "") || "ML seed labeling",
              });
            }
            if (!atlasBootBackgroundRequested) {
              // Same post-view hold point as encoding: hold through the
              // minutes-long ML labeling pass with an Enter escape, but release
              // immediately when there's no TTY to take the keypress.
              if (bootCanPromptForBackground()) {
                setBootEnterAction(() => requestAtlasBootBackground("tree-compression-enter"));
                updateBootFooter("ML tree labeling — hit Enter to continue in the background");
              } else {
                requestAtlasBootBackground("non-interactive-views-ready");
              }
            }
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
              atlasTreeFailed = true;
              bootPanel.updateTree({ state: "failed", detail: treeDetail });
            } else if (treeStatus === "ok") {
              atlasTreeTerminal = true;
              atlasTreeFailed = false;
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
            if (event.stage === "embeddings" || event.stage === "encoding") {
              renderEncodeBootActivity(event);
              return;
            }
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
            if (event.stage === "embeddings" || event.stage === "encoding") {
              renderEncodeBootActivity(event);
              return;
            }
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
        // Per-layer model: a failed boot index costs the degraded layers, not
        // the engine. Tools, gate, and MCP attachment stay up against whatever
        // artifacts exist; readiness-driven repair warms rebuild the rest in
        // the background through the scheduler. Deliberately NO runtime
        // disable here: it would no-op the repair warms just queued and turn
        // off tools this message promises stay up. (The engine is alive —
        // only the index work failed.)
        let repair = { actions: [], summary: "self-repair unavailable" };
        try {
          if (typeof enqueueAtlasSelfRepair === "function") {
            repair = (await enqueueAtlasSelfRepair({
              repoRoot: PROJECT_DIR,
              config: getAtlasIntegrationConfig(),
              reason: `boot_reindex_failed: ${detail}`,
            })) || repair;
          }
        } catch (err) {
          log?.warn?.("atlas", "ATLAS self-repair enqueue failed after boot index failure", {
            error: firstLine(err?.message || err),
          });
        }
        const msg = `ATLAS boot check: indexing failed${atlasBoot.repoId ? ` for ${atlasBoot.repoId}` : ""} (${detail})`;
        const repairActions = Array.isArray(repair.actions) ? repair.actions : [];
        const noteMsg = repairActions.length > 0
          ? `ATLAS continues with degraded layers (${repair.summary}); ${repairActions.length} repair warm${repairActions.length === 1 ? "" : "s"} queued.`
          : `ATLAS continues with degraded layers (${repair.summary}).`;
        log.warn("atlas", "Boot index failed — continuing with degraded layers; self-repair queued", {
          repoId: atlasBoot.repoId || null,
          graphDbPath: atlasBoot.graphDbPath || null,
          status: atlasBoot.status,
          detail,
          readiness: repair.summary,
          repairActions,
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
        return {
          atlasBoot,
          atlasRuntime: {
            attempted: false,
            skipped: "boot_failed",
            ok: false,
            backend: "atlas-v2",
          },
        };
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
        // Headless boots have no TTY to press Enter on — the footer action is
        // unreachable, so a warm wedged before the encode handoff left them
        // waiting on internal warm timeouts alone. Auto-background instead,
        // matching the non-interactive behavior at the views-ready handoffs.
        if (!bootCanPromptForBackground()) {
          requestAtlasBootBackground("atlas-soft-timeout-non-interactive");
          return;
        }
        setBootEnterAction(() => requestAtlasBootBackground("atlas-soft-timeout-enter"));
        updateBootFooter("hit Enter to continue with ATLAS in the background");
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
      try {
        const cleanup = cleanupAtlasForSession({ label: "Forced shutdown" });
        if (cleanup && typeof cleanup.then === "function") void Promise.resolve(cleanup).catch(() => {});
      } catch { /* forced shutdown continues */ }
      try { closeRuntimeStateForExit(); } catch { /* best-effort */ }
      process.exitCode = 1;
      exitProcess?.(1);
      return;
    }

    if (bootShutdownRequested) return;
    bootShutdownRequested = true;
    bootAbortController.abort(new Error(`${signal} during scheduler boot`));
    const label = signal === "SIGTERM" ? "Shutdown" : "Ctrl+C";
    console.log(`\n  ${C.yellow}${label} during boot - releasing scheduler lock...${C.reset}`);
    console.log(`  ${C.dim}(Ctrl+C again to force-exit)${C.reset}`);
    let stopPromise;
    try {
      stopPromise = Promise.resolve(scheduleSchedulerStop());
    } catch {
      try { this.#stopScheduler(scheduler); } catch { /* best-effort */ }
      stopPromise = Promise.resolve();
    }
    let atlasCleanupPromise;
    try {
      atlasCleanupPromise = Promise.resolve(cleanupAtlasForSession({ label: "Boot cleanup" }));
    } catch {
      atlasCleanupPromise = Promise.resolve();
    }
    bootCleanupPromise = Promise.allSettled([
      stopPromise,
      atlasCleanupPromise,
    ]).then(() => undefined);
    void bootCleanupPromise;
  };
  const bootSigintCleanup = () => cleanupDuringBoot("SIGINT");
  const bootSigtermCleanup = () => cleanupDuringBoot("SIGTERM");
  const bootSigbreakCleanup = () => cleanupDuringBoot("SIGBREAK");
  const bootMessageCleanup = (msg) => { if (msg === "shutdown") cleanupDuringBoot("SIGTERM"); };
  let bootSignalHandlersInstalled = false;
  const removeBootSignalHandlers = () => {
    if (!bootSignalHandlersInstalled) return;
    bootSignalHandlersInstalled = false;
    process.off("SIGINT", bootSigintCleanup);
    process.off("SIGTERM", bootSigtermCleanup);
    if (process.platform === "win32") {
      process.off("SIGBREAK", bootSigbreakCleanup);
      process.off("message", bootMessageCleanup);
    }
  };
  this._removeRunSignalHandlers = removeBootSignalHandlers;

  process.on("SIGINT", bootSigintCleanup);
  process.on("SIGTERM", bootSigtermCleanup);
  if (process.platform === "win32") {
    process.on("SIGBREAK", bootSigbreakCleanup);
    process.on("message", bootMessageCleanup);
  }
  bootSignalHandlersInstalled = true;

  let booted = false;
  try {
    booted = await scheduler.boot({
      onBeforeLoop,
      onBeforeLoopFatal: true,
      onBootEvent: handleSchedulerBootEvent,
      onBootAbort: (reason) => {
        if (!bootAbortController.signal.aborted) bootAbortController.abort(reason);
      },
    });
  } finally {
    if (!booted) {
      removeBootSignalHandlers();
      // scheduler.boot() can throw when a fatal pre-loop readiness check
      // fails. That skips the ordinary !booted return path below, so stop the
      // panel here as well or its render timer leaks into the next run/test.
      try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    }
  }
  if (!booted) {
    // Boot failed/aborted — tear the panel down so we leave clean stdout
    // for the user-facing message below.
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

  // Ctrl+C/SIGTERM after scheduler.boot() succeeded still releases the
  // scheduler lock via cleanupDuringBoot, but nothing below used to notice:
  // boot would march on through the warm/gate window, attach the TUI, and die
  // in runLoop with "called before successful boot()". Re-check at each
  // post-boot milestone so a shutdown in that window (including one that
  // landed just before boot reset its own stop flags) exits through the
  // graceful interrupted-boot path instead.
  const bailIfBootInterrupted = async () => {
    if (!bootShutdownRequested) return false;
    try { stopBootMonitor({ final: true }); } catch { /* observational */ }
    if (bootCleanupPromise) await bootCleanupPromise;
    removeBootSignalHandlers();
    console.log(`  ${C.yellow}Scheduler boot interrupted. Lock released; safe to restart.${C.reset}\n`);
    // Exit explicitly rather than just returning. If the interrupt landed during
    // the ATLAS warm/gate window, a backgrounded boot-warm worker thread is
    // fire-and-forget and never unref'd — its MessagePort keeps the event loop
    // alive, so a bare `return` would leave the process running (up to the 90-min
    // warm timeout) despite the "safe to restart" message, contending with any
    // restarted instance on the index DBs. Mirror the natural-completion and
    // signal-driven exit paths. (exitProcess is stubbed in tests, so callers
    // still observe the `return true`.)
    try { closeRuntimeStateForExit(); } catch { /* best-effort */ }
    process.exitCode = 0;
    exitProcess?.(0);
    return true;
  };
  // Resolves (never rejects) when a boot shutdown aborts the controller, so
  // the warm-phase and gate races below release immediately on Ctrl+C instead
  // of waiting out the ATLAS warm.
  const bootAborted = new Promise((resolve) => {
    const settle = () => resolve({ kind: "boot-aborted" });
    if (bootAbortController.signal.aborted) {
      settle();
      return;
    }
    bootAbortController.signal.addEventListener("abort", settle, { once: true });
  });
  if (await bailIfBootInterrupted()) return;

  // Same-device telemetry is a raw repo-scoped socket, independent of the
  // phone/web bridge. Failure is observational only: Bossy keeps reading the
  // durable SQLite ledger and this run continues normally.
  try {
    const bossyLocalStream = typeof this.createBossyLocalStream === "function"
      ? this.createBossyLocalStream({ projectDir: PROJECT_DIR })
      : new BossyLocalStream({ projectDir: PROJECT_DIR });
    await bossyLocalStream.start();
    this._bossyLocalStream = bossyLocalStream;
  } catch (err) {
    log?.warn?.("bridge", "Bossy local stream unavailable", {
      error: err?.message || String(err),
    });
  }

  // Let the top-level provider warmups settle in the BACKGROUND — they must
  // never gate the index phase. The deterministic ATLAS/SCIP warm never calls a
  // provider, so blocking the index behind provider auth (as this previously
  // did) only delayed indexing for no benefit. Each prime updates its own chip
  // as it resolves; allSettled never rejects, so a plain fire-and-forget is
  // safe.
  void Promise.allSettled(providerWarmups);

  // ── Indexing phase ─────────────────────────────────────────────────────
  // The entire upper boot section has settled (warmups + providers + scheduler
  // lock/orphan/pre-loop). Kick the ATLAS/SCIP warm now so the top of the panel
  // finishes independently before the ATLAS×SCIP matrix + zip take over. This
  // returns at the warm's soft-timeout; the real work continues and is awaited
  // by the gate just below, so the panel keeps animating live progress.
  //
  // Race the phase against the Enter/headless background request: the footer
  // advertises "hit Enter to load in the background" long before the phase's
  // soft-timeout, and headless boots auto-request at views-ready — both must
  // release this wait immediately. The gate below re-races the already-settled
  // request and takes its deferred-chip + late-completion-watcher branch. When
  // no request is made, the race waits on the phase exactly as before, so the
  // default remains: boot holds until the ATLAS index has fully synced. The
  // phase promise never rejects (bootWarmup converts failures to results), so
  // leaving it un-awaited after a background win is safe.
  if (startAtlasWarmupPhase) {
    await Promise.race([startAtlasWarmupPhase(), atlasBootBackgroundRequest, bootAborted]);
    if (await bailIfBootInterrupted()) return;
  }

  // ── TUI attach — from here on, stdout goes to the alt-screen buffer ─────
  // Finalize the boot panel before the alt-screen takes over. For TTY/TUI runs,
  // keep the already-rendered main-buffer panel and only move the cursor below
  // it; repainting here can stamp a second "posse boot" header into scrollback
  // before later terminal prompts (for example the post-run push offer).
  // stopBootMonitor → preserve/render boot monitor(final) → terminalOutputIntercept.release()
  // replays anything that tried to write to stdout/stderr while the panel was up.
  // Pre-flight gate: wait for the ATLAS index to finish building before the
  // runtime UI attaches and workers start. The warm runs in the boot worker
  // (off the event loop), so the scheduler lock keeps renewing while we wait —
  // jobs see a current index instead of one still building in the background.
  if (atlasWarmCompletion) {
    // The owner of interrupted/failed boot work is gone, so inspect artifacts
    // and queue bounded warm jobs that repair whatever is not ready. Also mark
    // ATLAS disabled for THIS REPO so wrap-up does not drain warm work against
    // a just-failed/torn-down conductor. The disable must stay repo-scoped:
    // a process can serve other repos whose ATLAS is healthy, and a global
    // entry would shadow every per-repo lookup (config.js checks global
    // first) and turn their tools off too.
    const repairAtlasAfterOwnerGone = async (reason) => {
      const repairReason = firstLine(reason);
      try {
        if (typeof enqueueAtlasSelfRepair === "function") {
          const repair = (await enqueueAtlasSelfRepair({
            repoRoot: PROJECT_DIR,
            config: getAtlasIntegrationConfig(),
            reason: repairReason,
          })) || { actions: [], summary: "self-repair unavailable" };
          log?.info?.("atlas", "ATLAS self-repair after interrupted boot work", {
            reason: repairReason,
            readiness: repair.summary,
            repairActions: repair.actions,
          });
        }
      } catch { /* best effort — the next boot readiness pass retries */ }
      try { disableAtlasForRun?.(repairReason, PROJECT_DIR); } catch { /* best effort */ }
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
            repairAtlasAfterOwnerGone(`boot_background_failed: ${firstLine(reason)}`);
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
          repairAtlasAfterOwnerGone(`boot_background_failed: ${firstLine(err?.message || err)}`);
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
        bootAborted,
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
      log?.warn?.("atlas", "ATLAS boot wait failed; entering TUI with degraded layers", {
        error: firstLine(err?.message || err),
      });
      repairAtlasAfterOwnerGone(`boot_wait_failed: ${firstLine(err?.message || err)}`);
    }
    if (await bailIfBootInterrupted()) return;
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

  stopBootMonitor({ final: true, preserve: useTui });
  if (useTui) {
    try { recordRunDiagnostic("display.starting", { concurrency: CONCURRENCY }); } catch { /* observational */ }
    display = new Display({ concurrency: CONCURRENCY, rightMode: "monitor", projectDir: PROJECT_DIR });
    this._activeDisplay = display;
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

  worker = new Worker({ autoApprove: AUTO_APPROVE, projectDir: PROJECT_DIR, display, dryRun: DRY_RUN, nonInteractive, stallTimeout: STALL_TIMEOUT, leaseSec: scheduler.leaseSec });
  this._activeWorker = worker;

  if (display) {
    const revivedHumanJobs = requeueWaitingHumanInputJobs();
    for (const { work_item_id } of revivedHumanJobs) {
      refreshWorkItemStatus(work_item_id);
    }
    if (revivedHumanJobs.length > 0) {
      display.addEvent(`${C.cyan}Requeued ${revivedHumanJobs.length} parked human prompt(s)${C.reset}`);
    }
  }

  const displayActions = new RunDisplayActions({
    display,
    worker,
    projectDir: PROJECT_DIR,
    C,
    inferWiMode,
    researchBudgetMetadata,
    createWorkItem,
    updateWorkItemStatus,
    createInitialResearchOrPlanJob,
    shouldUseRedTeamPlanForWorkItem,
    classifyResearchForRouting,
    ensureArtifactDirs,
    wiScopeId,
    artifactsDir,
    getResolvedImageProtocol,
    createJob,
    getJob,
    getWorkItem,
    storeArtifact,
    logEvent,
    cancelWorkItemJobs,
    cleanupWiBranchAsync,
    skipJob,
    refreshWorkItemStatus,
    runLiveReview,
    defaultResearchModelTier,
    researchBudgetToReasoningEffort,
    researchPayload,
    refreshDisplaySnapshotsForQueue,
  }).wire();
  const shutdown = new RunShutdownController({
    getDisplay: () => display,
    worker,
    scheduler,
    scheduleSchedulerStop,
    stopDisplaySnapshotCaches,
    cleanupAtlasForSession,
    emitCloseoutStatus,
    flushCloseoutStatus,
    C,
    listJobs,
    requeueForShutdown,
    refreshWorkItemStatus,
    closeRuntimeState: closeRuntimeStateForExit,
    finalizeRuntimeResources: async () => {
      // finishAfterScheduler already released these per-run resources. Clear
      // the outer fallback references before the injected process-level close
      // so a test exit stub (which returns instead of terminating) stays
      // idempotent when RunSession's outer finally executes.
      this._cleanupRunAtlas = null;
      this._activeWorker = null;
      await this.#disposeProcessResources();
    },
    exitProcess,
  });
  this._activeShutdown = shutdown;
  removeBootSignalHandlers();
  shutdown.install();
  try {
    recordRunDiagnostic("scheduler.run_loop_starting", {
      owner_id: scheduler.ownerId || null,
      concurrency: CONCURRENCY,
    });
  } catch { /* observational */ }

  // Hold the Atlas conductor warm for the whole run. Native model residency is
  // owned by the mandatory posse-atlas worker.
  try { setConductorKeepWarmForRun(true); } catch { /* best-effort */ }

  const schedulerCallbacks = new RunSchedulerLoopCallbacks({
    getDisplay: () => display,
    C,
    worker,
    getJob,
    idleAutoMerge,
    hasAutoMergeableCompletedWorkItems,
    autoMergePendingReviewBlockers,
    describePendingReviewLockBlockers,
  });
  await scheduler.runLoop(
    (job) => worker.execute(job),
    schedulerCallbacks.callbacks(),
  );
  // Scheduler.runLoop owns its successful-return stop path. Drop the outer
  // rollback reference; exceptions retain it so RunSession's finally can
  // release a lock when failure happened before runLoop installed its guard.
  if (this._activeScheduler === scheduler) this._activeScheduler = null;
  try {
    recordRunDiagnostic("scheduler.run_loop_returned", {
      owner_id: scheduler.ownerId || null,
      shutdown_in_progress: !!shutdown.inProgress,
    });
  } catch { /* observational */ }

  if (display && idleAutoMerge.isRunning()) {
    const pendingAutoMergeWrapUp = createRunWrapUpTracker(display, {
      subtitle: "All jobs are done. Finishing pending merge and ATLAS closeout; Enter leaves remaining ATLAS/ONNX work queued.",
    });
    pendingAutoMergeWrapUp.start("auto-merge", "finishing pending merge");
    await idleAutoMerge.wait();
    pendingAutoMergeWrapUp.done("auto-merge", "finished");
  } else {
    await idleAutoMerge.wait();
  }

  // ── Post-scheduler: clean up worktrees if shutdown was triggered ──
  if (await shutdown.finishAfterScheduler({
    needsGit,
    schedulerStopPromise,
    runBoundedCloseoutWorktreeCleanup,
  })) {
    return;
  }

  // Replace scheduler cleanup handler with a simpler one for the wrap-up phase.
  // The display is still in raw mode, so Ctrl+C is intercepted by keypress and
  // emitted as process.emit("SIGINT") — without a handler, nothing happens.
  shutdown.uninstall();
  const cleanupInterruptedWrapUp = (signal) => handleWrapUpSignal({
    signal,
    display,
    cleanupAtlasForSession,
    finalizeRuntimeResources: async () => {
      // handleWrapUpSignal already completed the local ATLAS close. Clear its
      // fallback reference, then await the rest of the same idempotent session
      // teardown used for exceptions and graceful scheduler shutdown.
      this._cleanupRunAtlas = null;
      await this.#disposeRunResources();
    },
    exit: exitProcess,
  });
  const wrapUpSigintCleanup = () => cleanupInterruptedWrapUp("SIGINT");
  const wrapUpSigtermCleanup = () => cleanupInterruptedWrapUp("SIGTERM");
  process.on("SIGINT", wrapUpSigintCleanup);
  process.on("SIGTERM", wrapUpSigtermCleanup);

  // Auto-merge performs a defensive WI-status reconciliation before it scans
  // for mergeable branches, so stale active rows do not have to pass through
  // review just to be merged.

  try {
    let nextAction = null;
    if (display) {
      const liveReviewPromise = displayActions.getLiveReviewPromise();
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
      process.off("SIGINT", wrapUpSigintCleanup);
      process.off("SIGTERM", wrapUpSigtermCleanup);
      // A rerun stays in the same process, so process-wide daemon/MCP/native
      // owners must remain available. Per-iteration state must not: the next
      // call overwrites these fields and would otherwise strand the prior
      // worker's reusable agents and ATLAS cleanup handle.
      await this.#disposeIterationResources();
      await this.run();
      return;
    }
    // Wrap-up merges queued ATLAS follow-up work; finish it while the
    // conductor is still alive so the next boot opens on a current index.
    await drainPendingAtlasWarmJobs({
      label: "Run wrap-up",
      shouldExitEarly: () => display?.isWrapUpEarlyExitRequested?.() === true,
    });
    // Daemon-layer health: the worker→per-call fallback is transparent by
    // design, which means a broken bridge/host is invisible unless reported.
    const fallbackStats = nativeBinariesForRun?.workerFallbackStats?.() || { total: 0, byBinary: {} };
    if (fallbackStats.total > 0) {
      const detail = Object.entries(fallbackStats.byBinary)
        .map(([name, s]) => {
          const reasons = Object.entries(s.byReason || {}).map(([reason, count]) => `${reason}=${count}`).join(", ");
          return `${name}=${s.count}${reasons ? ` [${reasons}]` : ""}`;
        })
        .join(", ");
      emitCloseoutStatus(`Run wrap-up: native worker degraded to ${fallbackStats.total} per-call spawn(s) (${detail}) — daemon layer needs attention.`, C.yellow);
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
    // Retire every supervised daemon host (EOF + drain grace, no mid-call
    // kills), then sweep this process's daemon ledger so thread-minted strays
    // can't outlive the run. A clean exit leaves zero hosts and no ledger.
    try {
      const swept = await daemonSupervisorForRun?.shutdownAll?.() || { reaped: 0 };
      if (swept.reaped > 0) {
        emitCloseoutStatus(`Run wrap-up: reaped ${swept.reaped} stray daemon host(s) at exit.`, C.yellow);
        await flushCloseoutStatus();
      }
    } catch { /* shutdown sweep is best-effort */ }
    try {
      await worker?.disposeAgents?.("run_complete");
    } catch { /* agent gate shutdown is best-effort */ }
    try {
      await persistentMcpOwnerForRun.close({ force: true });
    } catch { /* MCP owner shutdown is best-effort */ }
    await cleanupResidualWorktreesAfterAtlas({ label: "Run wrap-up" });
  }

  // Natural-completion exit. The finally above disposes the conductor, ONNX
  // daemon, native daemon hosts, and MCP owner, but a backgrounded ATLAS
  // boot-warm worker thread (the operator pressed Enter to defer the encode)
  // is fire-and-forget and never unref'd — its MessagePort keeps the event loop
  // alive, so the process hangs after "Run wrap-up: done." instead of exiting
  // (Enter does nothing; only Ctrl+C escapes). Every signal-driven exit path
  // already exits explicitly; mirror them here — record the clean shutdown,
  // flush runtime state, and exit. Scheduler drainage is not itself a success
  // verdict: a job can dead-letter cleanly and leave its work item failed.
  // Aggregate work-item state accounts for successful fix-child recovery while
  // still returning a truthful shell status for failed/canceled work.
  const completion = summarizeRunCompletion(
    [...wiIds].map((id) => getWorkItem(id)).filter(Boolean),
  );
  if (!completion.ok) {
    const unsuccessful = completion.failures.length > 0
      ? completion.failures
      : completion.incomplete;
    const detail = unsuccessful
      .map((item) => `WI#${item.id ?? "?"} ${item.status}`)
      .join(", ");
    const label = completion.failures.length > 0
      ? "Run completed with unsuccessful work item(s)"
      : "Run stopped with work item(s) still requiring action";
    const color = completion.failures.length > 0 ? C.red : C.yellow;
    console.error(`\n  ${color}${label}: ${detail}.${C.reset}\n`);
  }
  closeRuntimeStateForExit();
  process.exitCode = completion.exitCode;
  exitProcess?.(completion.exitCode);

  }
}
