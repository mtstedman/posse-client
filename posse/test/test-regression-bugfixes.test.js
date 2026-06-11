import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AdminTUI, purgeRuntimeLogs as purgeRuntimeLogsFromAdmin } from "../lib/domains/ui/classes/admin/AdminTUI.js";
import { Job } from "../lib/domains/queue/classes/job/Job.js";
import { Scheduler } from "../lib/domains/scheduler/classes/Scheduler.js";
import { Worker, filterFileRequestsToOutOfScope, leaseRenewalIntervalMs, renewJobLeaseOrAbort } from "../lib/domains/worker/classes/Worker.js";
import { FixRole } from "../lib/domains/worker/classes/roles/fix.js";
import { closeDb, getDb, __testInstallJsonValidityTriggers, __testRepairArtifactsTableSchema, __testRepairWorkItemsGovernanceTierSchema } from "../lib/shared/storage/functions/index.js";
import { Display } from "../lib/domains/ui/classes/display/Display.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { renderAtlasHandoffSections } from "../lib/domains/handoff/functions/helpers/atlas-context.js";
import { ensureAtlasCommitReindexHook, ensureAtlasRepoIndexedOnBoot, getAtlasIntegrationConfig } from "../lib/domains/integrations/functions/atlas.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { ledgerDbPath, mainViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";
import { targetBranchNativeParity } from "./core/support/git-native-target-branch.js";
import {
  nativeHeartbeatSkipReason,
  seedNativeHeartbeat,
  installNativeHeartbeatForProcess,
} from "./core/support/native-heartbeat.js";
import { assertHandoffScopePreflight } from "../lib/domains/handoff/functions/helpers/scope-preflight.js";
import {
  recordObservation,
  __testGetObservationStreamStateForTests,
  __testRememberToolReplayFingerprint,
  __testResetObservationStreamForTests,
  __testResetToolReplayCache,
  __testSetObservationStreamWriterForTests,
  __testToolReplayCacheStats,
} from "../lib/domains/observability/functions/observations.js";
import {
  acquireLease,
  addDependency,
  completeAttempt,
  createAgentCall,
  createJob,
  createWorkItem,
  getAgentCallsByWorkItem,
  getAttempts,
  getEvents,
  getEventsByWorkItem,
  getDependencies,
  getJob,
  getWorkItem,
  getSchedulerLockInfo,
  incrementAndCreateAttempt,
  listJobsByWorkItem,
  logEvent,
  setJobResult,
  setSetting,
  setWorkItemBranch,
  updateJobStatus,
  updateWorkItemStatus,
  updateWorkItemMetadata,
} from "../lib/domains/queue/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { __testQueueInternalAssessmentRetry } from "../lib/domains/worker/classes/roles/assessor.js";
import { processVerdict } from "../lib/domains/worker/classes/roles/assessor.js";
import { resolvePathWithin } from "../lib/domains/worker/functions/helpers/scope.js";
import { gitCommitAll } from "../lib/domains/git/functions/commit-scope.js";
import { configureWorktreeScope, snapshotAndResetDirtyWorktree } from "../lib/domains/git/functions/worktree.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../lib/domains/queue/functions/reviewable.js";
import { __testBuildCodexDeterministicReadConfigOverrides } from "../lib/domains/providers/functions/codex.js";
import { spawnPlanAfterResearch } from "../lib/domains/worker/functions/helpers/pipeline-continuation.js";
import { validatePlannedTask } from "../lib/domains/worker/functions/helpers/plan-routing.js";
import {
  MutationPolicy,
  inferGeneratedArtifactDeletionTargets,
  scopedDeleteTargets,
} from "../lib/shared/scope/classes/MutationPolicy.js";
import {
  COMMAND_DEFINITIONS,
  getCommandDefinition,
  requiresProviderForCommand,
  requiresWritableArtifactsForCommand,
  shouldRefreshContextAfterCommand,
} from "../lib/domains/cli/functions/command-registry.js";
import { buildImageInjectionPayload, handleWrapUpSignal, PROVIDER_AUTH_WARMUP_TIMEOUT_MS, RunSession } from "../lib/domains/cli/functions/run-session.js";
import { ReviewSession } from "../lib/domains/cli/functions/review-session.js";
import { __testResetClaudeResolution } from "../lib/domains/providers/functions/claude.js";
import { getAvailableProviders, getProviderHealth, isProviderReady } from "../lib/domains/providers/functions/provider.js";
import { artifactsDir, wiScopeId } from "../lib/domains/artifacts/functions/index.js";
import {
  closeAccountSettingsDb,
  setAccountSettings,
  setAccountSettingsPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";
import {
  buildScopePredicates,
  createBashExecutor,
  createDeterministicToolkit,
} from "../lib/functions/toolkit/index.js";
import { purgeRuntimeLogs as purgeRuntimeLogsFromSharedModule } from "../lib/domains/ui/functions/admin/purge-runtime-logs.js";
import { applySnapshotDiff } from "../lib/domains/cleanup/functions/actions.js";
import { createStatusCommands, parseStatusOptions } from "../lib/domains/cli/functions/status-command.js";
import { getCommandPositionalArgs, parseConcurrency, parseStallTimeout } from "../lib/domains/cli/functions/flags.js";
import { buildColors, colorsEnabled } from "../lib/shared/format/functions/colors.js";
import { processIterativeWrapUp } from "../lib/domains/planning/functions/orchestration.js";
import { parseWorkItemMetadata } from "../lib/domains/planning/functions/state.js";
import { normalizeRepoPathForGate } from "../lib/domains/integrations/functions/deterministic-mcp/source-file-gate.js";
import { __testLeaseClockSettingReadFallbacks, leaseRequeueGraceSec } from "../lib/domains/queue/functions/lease-clock.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const POSSE_ROOT = path.resolve(TEST_DIR, "..");

const TRANSIENT_CLEANUP_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

const removeTempTree = (target) => {
  const options = {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 120 : 5,
    retryDelay: process.platform === "win32" ? 500 : 100,
  };
  try {
    fs.rmSync(target, options);
  } catch (err) {
    if (process.platform !== "win32" || !TRANSIENT_CLEANUP_ERRORS.has(err?.code)) {
      throw err;
    }
  }
};

function withTempRuntimeDb(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-regression-db-"));
  closeDb();
  setRuntimePathOverridesForTests({
    projectDir: root,
    runtimeRoot: path.join(root, ".posse"),
    dbPath: path.join(root, ".posse", "db", "orchestrator.db"),
  });
  const cleanup = () => {
    closeDb();
    setRuntimePathOverridesForTests(null);
    removeTempTree(root);
  };
  try {
    const result = fn(root);
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function withCapturedProcessSignals(fn) {
  const realOn = process.on;
  const realOff = process.off;
  const capturedEvents = new Set(["SIGINT", "SIGTERM", "SIGBREAK", "message"]);
  const handlers = new Map();
  const signalApi = {
    handlersFor(event) {
      return handlers.get(event) || [];
    },
    first(event) {
      return this.handlersFor(event)[0] || null;
    },
    count(event) {
      return this.handlersFor(event).length;
    },
  };
  const restore = () => {
    process.on = realOn;
    process.off = realOff;
  };

  process.on = function patchedProcessOn(event, listener) {
    if (capturedEvents.has(event)) {
      const list = handlers.get(event) || [];
      list.push(listener);
      handlers.set(event, list);
      return this;
    }
    return realOn.call(this, event, listener);
  };
  process.off = function patchedProcessOff(event, listener) {
    if (capturedEvents.has(event)) {
      const list = handlers.get(event) || [];
      const next = list.filter((candidate) => candidate !== listener);
      if (next.length > 0) handlers.set(event, next);
      else handlers.delete(event);
      return this;
    }
    return realOff.call(this, event, listener);
  };

  try {
    const result = fn(signalApi);
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function createRunSessionBootTestDeps(overrides = {}) {
  class DefaultScheduler {
    constructor() {
      this.leaseSec = 60;
    }

    async boot() {
      return false;
    }

    stop() {}
  }

  return {
    maybeAnnounceAutoMergeSetting: () => {},
    listJobs: () => [{
      id: 1,
      work_item_id: 1,
      status: "queued",
      job_type: "dev",
      title: "Test job",
      payload_json: "{}",
    }],
    jobsNeedGitWorktree: () => false,
    processIterativeWrapUp: async () => ({ rerun: false }),
    listWorkItems: () => [],
    isReviewableWorkItem: () => false,
    cmdReview: async () => {},
    C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "" },
    CONCURRENCY: 1,
    getWorkItem: () => ({ id: 1, status: "planned", branch_name: null }),
    updateWorkItemStatus: () => {},
    ensureRepoSetupConfirmed: async () => true,
    ensureGitReady: () => {},
    NO_TUI: true,
    Scheduler: DefaultScheduler,
    primeProviderUsageAuth: () => ({ attempted: false, providers: [] }),
    PROJECT_DIR: process.cwd(),
    getConfiguredProviderUsageAsync: async () => [],
    startupWorktreeCleanup: () => {},
    ensureAtlasCommitReindexHook: () => ({ attempted: false }),
    getAtlasIntegrationConfig: () => ({}),
    ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
    disableAtlasForRun: () => {},
    log: { warn: () => {} },
    Display: class {},
    STALL_TIMEOUT: 1,
    Worker: class {
      execute() {}
    },
    AUTO_APPROVE: false,
    DRY_RUN: false,
    requeueWaitingHumanInputJobs: () => [],
    refreshWorkItemStatus: () => {},
    inferWiMode: () => "build",
    researchBudgetMetadata: () => ({}),
    createWorkItem: () => ({ id: 2 }),
    createInitialResearchOrPlanJob: () => {},
    shouldUseRedTeamPlanForWorkItem: () => false,
    classifyResearchForRouting: () => {},
    ensureArtifactDirs: () => {},
    wiScopeId: () => "wi-1",
    artifactsDir: () => "",
    getResolvedImageProtocol: () => ({}),
    createJob: () => ({}),
    getJob: () => null,
    storeArtifact: () => {},
    logEvent: () => {},
    cancelWorkItemJobs: () => {},
    cleanupWiBranch: () => {},
    skipJob: () => {},
    runLiveReview: async () => {},
    listJobsByWorkItem: () => [],
    getArtifacts: () => [],
    getToolInvocationCountsByJob: () => ({}),
    getRecentToolInvocations: () => [],
    listActiveFileLocks: () => [],
    researchBudgetToReasoningEffort: () => "medium",
    researchPayload: () => ({}),
    autoMergeCompletedWorkItems: async () => 0,
    autoMergePendingReviewBlockers: false,
    describePendingReviewLockBlockers: () => null,
    wrapUpTui: async () => ({ rerun: false }),
    wrapUp: async () => ({ rerun: false }),
    offerPush: async () => {},
    exitProcess: () => {},
    ...overrides,
  };
}

function seedAccountSetting(dbPath, key, value) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare(`
      INSERT INTO account_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `).run(key, value);
  } finally {
    db.close();
  }
}

function withTempAccountSettings(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-account-settings-"));
  const dbPath = path.join(root, "account.db");
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(dbPath);
  const cleanup = () => {
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(null);
    removeTempTree(root);
  };
  try {
    const result = fn(root);
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

after(() => {
  closeAccountSettingsDb();
});

describe("targeted regression bugfixes", () => {
  it("routes admin log purge through the shared maintenance implementation", () => {
    assert.equal(purgeRuntimeLogsFromAdmin, purgeRuntimeLogsFromSharedModule);
  });

  it("purges terminal work item history without deleting active telemetry", () => withTempRuntimeDb(() => {
    const activeWi = createWorkItem("Active purge survivor", "keep active telemetry");
    const activeJob = createJob({ work_item_id: activeWi.id, job_type: "dev", title: "active job" });
    const activeLease = acquireLease(activeJob.id, "test-worker");
    const activeAttempt = incrementAndCreateAttempt(activeJob.id, activeLease.leaseToken, "dev").attempt;
    logEvent({
      work_item_id: activeWi.id,
      job_id: activeJob.id,
      attempt_id: activeAttempt.id,
      event_type: "test.active",
      actor_type: "system",
      message: "active event",
    });
    recordObservation({
      work_item_id: activeWi.id,
      job_id: activeJob.id,
      attempt_id: activeAttempt.id,
      observation_type: "tool.atlas.context",
      summary: "active observation",
    });
    createAgentCall({
      work_item_id: activeWi.id,
      job_id: activeJob.id,
      attempt_id: activeAttempt.id,
      role: "dev",
      model_tier: "standard",
      atlas_method: "context",
    });

    const terminalWi = createWorkItem("Terminal purge target", "remove history");
    const terminalJob = createJob({ work_item_id: terminalWi.id, job_type: "dev", title: "terminal job" });
    const terminalLease = acquireLease(terminalJob.id, "test-worker");
    const terminalAttempt = incrementAndCreateAttempt(terminalJob.id, terminalLease.leaseToken, "dev").attempt;
    logEvent({
      work_item_id: terminalWi.id,
      job_id: terminalJob.id,
      attempt_id: terminalAttempt.id,
      event_type: "test.terminal",
      actor_type: "system",
      message: "terminal event",
    });
    recordObservation({
      work_item_id: terminalWi.id,
      job_id: terminalJob.id,
      attempt_id: terminalAttempt.id,
      observation_type: "tool.atlas.context",
      summary: "terminal observation",
    });
    createAgentCall({
      work_item_id: terminalWi.id,
      job_id: terminalJob.id,
      attempt_id: terminalAttempt.id,
      role: "dev",
      model_tier: "standard",
      atlas_method: "context",
    });
    updateJobStatus(terminalJob.id, "succeeded", { leaseToken: terminalLease.leaseToken });
    updateWorkItemStatus(terminalWi.id, "complete");

    const result = purgeRuntimeLogsFromSharedModule();
    assert.equal(result.historyWorkItems, 1);
    assert.equal(result.atlasObservations, 1);
    assert.equal(result.atlasAgentCalls, 1);

    const db = getDb();
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE id = ?`).get(activeWi.id).count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE id = ?`).get(terminalWi.id).count, 0);
    assert.equal(getEvents(activeJob.id).some((event) => event.event_type === "test.active"), true);
    assert.equal(getAgentCallsByWorkItem(activeWi.id).length, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM job_observations WHERE work_item_id = ?`).get(activeWi.id).count, 1);
  }));

  it("offers push using the actual run wrap-up merge count", async () => {
    const offered = [];
    const session = new ReviewSession({
      cleanupRunningAgentCalls: () => {},
      listJobs: () => [
        { id: 1, status: "succeeded" },
        { id: 2, status: "succeeded" },
      ],
      cmdDashboard: () => {},
      C: {
        bold: "",
        reset: "",
        green: "",
        dim: "",
        cyan: "",
      },
      notifyDirtyState: async () => {},
      processIterativeWrapUp: async () => ({ rerun: false }),
      autoMergeCompletedWorkItems: async () => 2,
      listWorkItems: () => [],
      isReviewableWorkItem: () => false,
      ask: async () => "n",
      offerPush: async (count) => { offered.push(count); },
      reviewSuggestions: async () => {},
      ensureCleanTargetBranch: () => {},
    });

    await session.wrapUp();

    assert.deepEqual(offered, [2]);
  });

  it("passes the iterative merge gate through the run-start wrap-up path", async () => {
    const mergeGate = async () => ({ ok: true });
    let wrapUpOpts = null;
    const session = new RunSession({
      maybeAnnounceAutoMergeSetting: () => {},
      listJobs: () => [],
      jobsNeedGitWorktree: () => false,
      processIterativeWrapUp: async (opts) => {
        wrapUpOpts = opts;
        return { rerun: false };
      },
      mergeIterativePassToTarget: mergeGate,
      autoMergeCompletedWorkItems: async () => 0,
      listWorkItems: () => [],
      isReviewableWorkItem: () => false,
      cmdReview: async () => {},
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "" },
      NO_TUI: true,
    });

    await session.run();

    assert.equal(wrapUpOpts.reason, "run start");
    assert.equal(wrapUpOpts.mergeIterativePassToTarget, mergeGate);
  });

  it("passes the iterative merge gate through review wrap-up paths", async () => {
    const mergeGate = async () => ({ ok: true });
    const captured = [];
    const session = new ReviewSession({
      cleanupRunningAgentCalls: () => {},
      listJobs: () => [{ id: 1, status: "succeeded" }],
      cmdDashboard: () => {},
      C: { bold: "", reset: "", green: "", dim: "", cyan: "", red: "" },
      notifyDirtyState: async () => {},
      processIterativeWrapUp: async (opts) => {
        captured.push(opts);
        return { rerun: true, spawned: 1 };
      },
      mergeIterativePassToTarget: mergeGate,
      iterativeRerunDelayMs: 0,
    });
    const display = { addEvent: () => {} };

    await session.wrapUp();
    await session.wrapUpTui(display);

    assert.equal(captured[0].reason, "run wrap-up");
    assert.equal(captured[0].mergeIterativePassToTarget, mergeGate);
    assert.equal(captured[1].reason, "TUI wrap-up");
    assert.equal(captured[1].display, display);
    assert.equal(captured[1].mergeIterativePassToTarget, mergeGate);
  });

  it("normalizes trailing-slash repo paths for exported ATLAS source gate callers", () => {
    assert.equal(normalizeRepoPathForGate("src/foo/"), "src/foo");
    assert.equal(normalizeRepoPathForGate("./src//foo///"), "src/foo");
  });

  it("logs and counts lease-clock settings read fallbacks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-account-settings-broken-"));
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(root);
    const before = __testLeaseClockSettingReadFallbacks();
    try {
      assert.equal(leaseRequeueGraceSec(), 60);
      assert.equal(__testLeaseClockSettingReadFallbacks(), before + 1);
    } finally {
      closeAccountSettingsDb();
      setAccountSettingsPathForTests(null);
      removeTempTree(root);
    }
  });

  it("auto-merges before opening live review when completed branches are mergeable", async () => {
    const events = [];
    let autoMergeArgs = null;
    let openedReview = false;
    const display = {
      addEvent: (message) => events.push(message),
      requestRender: () => {},
      enterApprovalMode: async () => { openedReview = true; },
    };

    const session = new ReviewSession({
      autoMergeCompletedWorkItems: async (args) => {
        autoMergeArgs = args;
        return 1;
      },
      listReviewableWorkItemsForApprovalFromModule: () => [],
      isReviewableWorkItem: () => true,
      buildReviewReportDataFromModule: () => [],
      saveReportFromModule: () => {},
      C: { cyan: "", green: "", dim: "", reset: "" },
    });

    await session.runLiveReview(display);

    assert.equal(autoMergeArgs.display, display);
    assert.equal(autoMergeArgs.reason, "live review");
    assert.equal(openedReview, false);
    assert.ok(events.some((line) => line.includes("after auto-merge")));
  });

  it("does not dismiss live review as empty when the target branch is dirty", async () => {
    const events = [];
    let openedReview = false;
    const display = {
      addEvent: (message) => events.push(message),
      requestRender: () => {},
      enterApprovalMode: async () => { openedReview = true; },
    };

    const session = new ReviewSession({
      autoMergeCompletedWorkItems: async () => 0,
      listReviewableWorkItemsForApprovalFromModule: () => [],
      isReviewableWorkItem: () => true,
      buildReviewReportDataFromModule: () => [],
      saveReportFromModule: () => {},
      worktreeStatusFn: () => ({
        targetDirty: true,
        targetFiles: [{ path: "local.txt" }],
      }),
      getTargetBranch: () => "main",
      C: { red: "", green: "", dim: "", reset: "" },
    });

    await session.runLiveReview(display);

    assert.equal(openedReview, false);
    assert.ok(events.some((line) => line.includes("Target branch main has 1 uncommitted change")));
    assert.ok(events.some((line) => line.includes("Target branch still has uncommitted changes")));
    assert.equal(events.some((line) => line.includes("No pending work items")), false);
  });

  it("keeps wrap-up from claiming no review when the target branch is dirty", async () => {
    const events = [];
    const phases = [];
    let notified = false;
    let stopped = false;
    const display = {
      addEvent: (message) => events.push(message),
      setRunPhase: (phase) => phases.push(phase),
      stop: () => { stopped = true; },
    };

    const session = new ReviewSession({
      cleanupRunningAgentCalls: () => {},
      listJobs: () => [],
      processIterativeWrapUp: async () => ({ rerun: false }),
      autoMergeCompletedWorkItems: async () => 0,
      listWorkItems: () => [],
      isReviewableWorkItem: () => true,
      notifyDirtyState: async () => { notified = true; },
      worktreeStatusFn: () => ({
        targetDirty: true,
        targetFiles: [{ path: "local.txt" }],
      }),
      getTargetBranch: () => "main",
      C: { red: "", green: "", yellow: "", cyan: "", dim: "", reset: "" },
      emptyReviewPauseMs: 0,
    });

    await session.wrapUpTui(display);

    assert.equal(stopped, true);
    assert.equal(notified, true);
    assert.ok(phases.includes("Target branch needs cleanup"));
    assert.ok(events.some((line) => line.includes("Target branch main has 1 uncommitted change")));
    assert.ok(events.some((line) => line.includes("Target branch still has uncommitted changes")));
    assert.equal(events.some((line) => line.includes("No work items to review")), false);
  });

  it("surfaces manual TUI approval merge phases without indexing chatter in the user event log", async () => {
    const events = [];
    const phaseEvents = [];
    let advanced = false;
    const display = {
      addEvent: (message) => events.push(message),
      requestRender: () => {},
      setBlockingOverlay: () => {},
      _advanceApproval: () => { advanced = true; },
    };
    const wi = {
      id: 7,
      status: "complete",
      branch_name: "posse/wi-7-demo",
      merge_state: "pending_review",
    };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", reset: "" },
      updateWorkItemStatus: () => {},
      logEvent: () => {},
      gitMergeToTarget: (branch, projectDir, opts = {}) => {
        opts.onPhase?.({ phase: "merge", branch, target: "main" });
        opts.onPhase?.({ phase: "atlas-indexing", branch, target: "main" });
        phaseEvents.push("called");
        return { ok: true, message: "Merged branch", mergeHash: "abcdef1234567890" };
      },
      PROJECT_DIR: "/repo",
      execSync: () => "abcdef1234567890",
      TARGET_BRANCH: "main",
      setMergeState: () => {},
      cleanupWiBranch: () => true,
      getWorkItem: () => wi,
    });
    const reportData = [{ wi, jobs: [{ job_type: "dev" }] }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, "approve");
    await display._mergeQueuePromise();

    assert.deepEqual(result, { deferAdvance: true });
    assert.deepEqual(phaseEvents, ["called"]);
    assert.equal(advanced, true);
    assert.ok(events.some((line) => line.includes("WI#7: merging posse/wi-7-demo into main")));
    assert.ok(events.some((line) => line.includes("WI#7: merged posse/wi-7-demo into main at abcdef12")));
    assert.equal(events.some((line) => line.includes("WI#7: ATLAS post-commit indexing")), false);
  });

  it("allows manual TUI approval retry after auto-merge marks the item merge_failed", async () => {
    let advanced = false;
    let mergeState = null;
    const display = {
      addEvent: () => {},
      requestRender: () => {},
      setBlockingOverlay: () => {},
      _advanceApproval: () => { advanced = true; },
    };
    const loadedWi = {
      id: 70,
      status: "complete",
      branch_name: "posse/wi-70-demo",
      merge_state: "pending_review",
    };
    const freshWi = { ...loadedWi, merge_state: "merge_failed" };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", reset: "" },
      updateWorkItemStatus: () => true,
      logEvent: () => {},
      gitMergeToTarget: () => ({ ok: true, message: "Merged branch", mergeHash: "abcdef1234567890", targetBranch: "main" }),
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      setMergeState: (_wiId, next) => { mergeState = next; },
      cleanupWiBranch: () => true,
      getWorkItem: () => freshWi,
    });
    const reportData = [{ wi: loadedWi, jobs: [{ job_type: "dev" }] }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(loadedWi.id, "approve");
    await display._mergeQueuePromise();

    assert.deepEqual(result, { deferAdvance: true });
    assert.equal(advanced, true);
    assert.equal(mergeState, "merged");
    assert.match(reportData[0]._mergeResult, /Merged branch/);
  });

  it("allows manual TUI approval to merge failed items with terminal job failures", async () => {
    const logs = [];
    let statusCall = null;
    let merged = false;
    let advanced = false;
    const display = {
      addEvent: () => {},
      requestRender: () => {},
      setBlockingOverlay: () => {},
      _advanceApproval: () => { advanced = true; },
    };
    const wi = {
      id: 8,
      status: "failed",
      branch_name: "posse/wi-8-demo",
      merge_state: "pending_review",
    };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", reset: "" },
      updateWorkItemStatus: (...args) => {
        statusCall = args;
        return true;
      },
      logEvent: (event) => logs.push(event),
      gitMergeToTarget: () => {
        merged = true;
        return { ok: true, message: "Merged branch", mergeHash: "abcdef1234567890", targetBranch: "main" };
      },
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      setMergeState: () => {},
      cleanupWiBranch: () => true,
      getWorkItem: () => wi,
    });
    const reportData = [{ wi, jobs: [{ job_type: "dev", status: "failed" }] }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, "approve");
    await display._mergeQueuePromise();

    assert.deepEqual(result, { deferAdvance: true });
    assert.deepEqual(statusCall, [wi.id, "complete", { allowTerminalFailureBlockers: true }]);
    assert.equal(logs.some((event) => event.event_type === "work_item.approved"), true);
    assert.equal(merged, true);
    assert.equal(advanced, true);
    assert.match(reportData[0]._mergeResult, /Merged branch/);
  });

  it("blocks manual TUI approval when active completion guards refuse the work item", async () => {
    const logs = [];
    const display = {
      addEvent: () => {},
      requestRender: () => {},
      setBlockingOverlay: () => {},
      _advanceApproval: () => { throw new Error("approval should not advance"); },
    };
    const wi = {
      id: 8,
      status: "failed",
      branch_name: "posse/wi-8-demo",
      merge_state: "pending_review",
    };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", reset: "" },
      updateWorkItemStatus: () => false,
      logEvent: (event) => logs.push(event),
      gitMergeToTarget: () => { throw new Error("merge should not run"); },
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      getWorkItem: () => wi,
    });
    const reportData = [{ wi, jobs: [{ job_type: "dev", status: "running" }] }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, "approve");

    assert.equal(result, false);
    assert.match(reportData[0]._mergeResult, /Approval blocked: active required jobs remain/);
    assert.equal(logs.some((event) => event.event_type === "work_item.approved"), false);
  });

  it("keeps direct completion guarded but allows human-approved terminal failures", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Manual completion fixture", "exercise terminal failure override");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "failed implementation" });
    updateJobStatus(job.id, "failed");

    assert.equal(updateWorkItemStatus(wi.id, "complete"), false);
    assert.equal(getWorkItem(wi.id).status, "queued");

    assert.equal(updateWorkItemStatus(wi.id, "complete", { allowTerminalFailureBlockers: true }), true);
    assert.equal(getWorkItem(wi.id).status, "complete");
  }));

  it("blocks manual TUI approval while the WI worktree is dirty", async () => {
    const display = {
      addEvent: () => {},
      requestRender: () => {},
      setBlockingOverlay: () => {},
    };
    const wi = {
      id: 9,
      status: "complete",
      branch_name: "posse/wi-9-demo",
      merge_state: "pending_review",
    };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", reset: "" },
      updateWorkItemStatus: () => { throw new Error("status should not be changed before dirty files are resolved"); },
      logEvent: () => { throw new Error("approval should not be logged"); },
      gitMergeToTarget: () => { throw new Error("merge should not run"); },
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      getWorkItem: () => wi,
    });
    const reportData = [{
      wi,
      jobs: [{ job_type: "dev" }],
      worktreeStatus: {
        wtFiles: [
          { path: "src/app.js", inScope: true },
          { path: "tmp.txt", inScope: false, untracked: true },
        ],
        targetDirty: false,
        targetFiles: [],
      },
    }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, "approve");

    assert.equal(result, false);
    assert.match(reportData[0]._mergeResult, /Approval blocked: resolve 2 dirty WI worktree files, 1 in scope, 1 out of scope\/untracked before merging/);
  });

  it("explains discard from approval review when no discardable files exist", async () => {
    const display = {
      requestRender: () => {},
      setBlockingOverlay: () => {},
    };
    const wi = {
      id: 10,
      status: "complete",
      branch_name: "posse/wi-10-demo",
      merge_state: "pending_review",
    };
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", dim: "", reset: "" },
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      getWorkItem: () => wi,
    });
    const reportData = [{
      wi,
      jobs: [{ job_type: "dev" }],
      worktreeStatus: {
        wtDir: "/repo/.posse-worktrees/wi-10",
        wtExists: true,
        wtFiles: [{ path: "src/app.js", status: " M", inScope: true }],
      },
    }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, "discard_dirty");

    assert.deepEqual(result, { deferAdvance: true });
    assert.match(reportData[0]._mergeResult, /No out-of-scope or untracked files to discard/);
  });

  it("discards selected target files from approval review when the WI worktree is gone", async () => {
    const display = {
      requestRender: () => {},
      setBlockingOverlay: () => {},
    };
    const wi = {
      id: 11,
      status: "complete",
      branch_name: "posse/wi-11-demo",
      merge_state: "pending_review",
    };
    const discardCalls = [];
    const session = new ReviewSession({
      C: { red: "", green: "", yellow: "", cyan: "", dim: "", reset: "" },
      PROJECT_DIR: "/repo",
      TARGET_BRANCH: "main",
      logEvent: () => {},
      discardWorktreeFilesFn: (args) => {
        discardCalls.push(args);
        return { ok: true, message: "Discarded 1 path(s)", paths: args.paths };
      },
      worktreeStatusFn: () => ({
        wtDir: null,
        wtExists: false,
        wtFiles: [],
        targetDir: "/repo",
        targetDirty: false,
        targetFiles: [],
      }),
      getWorkItem: () => wi,
    });
    const reportData = [{
      wi,
      jobs: [{ job_type: "dev" }],
      worktreeStatus: {
        wtDir: null,
        wtExists: false,
        wtFiles: [],
        targetDir: "/repo",
        targetDirty: true,
        targetFiles: [{ path: "tsconfig.json", status: "??", untracked: true }],
      },
    }];

    session.installApprovalActions(display, reportData);
    const result = display.onApprovalAction(wi.id, {
      kind: "discard_files",
      paths: ["tsconfig.json"],
      location: "target",
      files: [{ path: "tsconfig.json", location: "target" }],
    });
    await display._mergeQueuePromise();

    assert.deepEqual(result, { deferAdvance: true });
    assert.equal(discardCalls.length, 1);
    assert.deepEqual(discardCalls[0], { wtDir: "/repo", paths: ["tsconfig.json"], targetBranch: "main" });
    assert.match(reportData[0]._mergeResult, /Discarded 1 file/);
    assert.equal(reportData[0].finalAssessment.status, "PASS");
  });

  it("smoke-tests advertised read-only and maintenance CLI commands", { skip: nativeHeartbeatSkipReason() ?? false }, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cli-smoke-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      const cli = path.resolve("orchestrator.js");
      const env = {
        ...process.env,
        POSSE_ACCOUNT_DB_PATH: path.join(repoRoot, "account.db"),
      };
      // Key-gated native git methods (resolveTargetBranch, ...) run inside the
      // spawned CLI; seed the central heartbeat settings so they authenticate.
      seedNativeHeartbeat(env.POSSE_ACCOUNT_DB_PATH);
      const runCli = (args) => execFileSync("node", [cli, ...args], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      const commands = [
        ["help"],
        ["queue"],
        ["status", "--json", "--limit", "1"],
        ["status", "--active", "--limit", "all"],
        ["health"],
        ["admin", "snapshot"],
        ["codex-models", "list"],
      ];

      for (const args of commands) {
        const output = runCli(args);
        assert.equal(typeof output, "string", args.join(" "));
      }

      const calls = JSON.parse(runCli(["calls", "--json"]));
      assert.equal(calls.filter_role, null);
      assert.equal(calls.totals.call_count, 0);
      assert.deepEqual(calls.stats, []);

      assert.throws(
        () => runCli(["events", "not-a-job-id"]),
        (err) => err.status === 2 && /numeric job id/.test(String(err.stderr || err.stdout || "")),
      );
      assert.throws(
        () => runCli(["not-a-real-command"]),
        (err) => err.status === 2 && /Unknown command: not-a-real-command/.test(String(err.stderr || err.stdout || "")),
      );

      seedAccountSetting(env.POSSE_ACCOUNT_DB_PATH, "provider_planner", "openai");
      seedAccountSetting(env.POSSE_ACCOUNT_DB_PATH, "claude_session_tokens", "123");
      const adminList = runCli(["admin", "list"]);
      assert.match(adminList, /provider_planner=openai/);
      assert.doesNotMatch(adminList, /claude_session_tokens/);

      seedAccountSetting(env.POSSE_ACCOUNT_DB_PATH, "provider_planner", "no-such-provider");
      assert.equal(typeof runCli(["cleanup", "--dry-run"]), "string");
    } finally {
      removeTempTree(repoRoot);
    }
  });

  it("keeps destructive cleanup auto mode behind an explicit confirmation", { skip: nativeHeartbeatSkipReason() ?? false }, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-confirm-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
      const env = { ...process.env, POSSE_ACCOUNT_DB_PATH: path.join(repoRoot, "account.db") };
      seedNativeHeartbeat(env.POSSE_ACCOUNT_DB_PATH);

      const snapshotDir = path.join(repoRoot, ".posse", "recovered-worktrees", "wi-1-old");
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify({
        captured_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        reason: "test-old-snapshot",
        work_item_id: 1,
      }), "utf8");
      seedAccountSetting(env.POSSE_ACCOUNT_DB_PATH, "provider_planner", "no-such-provider");

      const output = execFileSync("node", [
        path.resolve("orchestrator.js"),
        "cleanup",
        "--auto",
      ], {
        cwd: repoRoot,
        input: "n\n",
        encoding: "utf8",
        env,
      });

      assert.match(output, /Proceed with --auto discard of 1 item\(s\)\? \(y\/N\):/);
      assert.match(output, /Canceled\. No cleanup actions taken\./);
      assert.equal(fs.existsSync(snapshotDir), true);
    } finally {
      removeTempTree(repoRoot);
    }
  });

  it("rolls back apply-diff failures to the original branch and clean tree", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-apply-diff-rollback-"));
    // The snapshot must live under the managed recovery root (.posse/recovered-worktrees)
    // or applySnapshotDiff refuses it before reaching the patch-apply/rollback path.
    const snapshotRoot = path.join(repoRoot, ".posse", "recovered-worktrees", "bad-snapshot");
    fs.mkdirSync(snapshotRoot, { recursive: true });
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "a.txt"), "base\n", "utf8");
      execFileSync("git", ["add", "a.txt"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

      fs.writeFileSync(path.join(repoRoot, "a.txt"), "staged recovery\n", "utf8");
      const stagedPatch = execFileSync("git", ["diff"], { cwd: repoRoot, encoding: "utf8" });
      execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repoRoot, stdio: "ignore" });

      fs.writeFileSync(path.join(snapshotRoot, "manifest.json"), JSON.stringify({ head_sha: head }), "utf8");
      fs.writeFileSync(path.join(snapshotRoot, "staged.patch"), stagedPatch, "utf8");
      fs.writeFileSync(path.join(snapshotRoot, "diff.patch"), "not a patch\n", "utf8");

      assert.throws(() => applySnapshotDiff({
        id: "bad-snapshot",
        storageType: "directory",
        path: snapshotRoot,
        projectDir: repoRoot,
      }, repoRoot), /No valid patches|patch/);

      const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf8" }).trim();
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
      const recoveryBranches = execFileSync("git", ["branch", "--list", "posse/recovery/*"], { cwd: repoRoot, encoding: "utf8" }).trim();
      assert.equal(branch, "main");
      assert.equal(status, "");
      assert.equal(fs.readFileSync(path.join(repoRoot, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "base\n");
      assert.equal(recoveryBranches, "");
    } finally {
      removeTempTree(repoRoot);
    }
  });

  it("reports a missing Claude CLI as readiness instead of exiting", () => {
    const oldPath = process.env.PATH;
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "posse-empty-path-"));
    try {
      process.env.PATH = emptyPath;
      __testResetClaudeResolution();
      const ready = isProviderReady("claude");
      assert.equal(ready.ready, false);
      assert.match(ready.reason || "", /Could not find 'claude'/);
    } finally {
      process.env.PATH = oldPath;
      __testResetClaudeResolution();
      removeTempTree(emptyPath);
    }
  });

  it("does not report Claude health when every role is routed elsewhere", () => withTempAccountSettings(() => {
    setAccountSettings({
      provider_dev: "openai",
      provider_artificer: "openai",
      provider_researcher: "openai",
      provider_planner: "openai",
      provider_preflight: "openai",
      provider_assessor: "openai",
      provider_delegator: "openai",
    });
    const health = getProviderHealth();
    assert.equal(health.some((row) => row.provider === "claude"), false);
    assert.equal(health.some((row) => row.provider === "openai"), true);
  }));

  it("canonicalizes provider setting casing before selection and health checks", () => withTempAccountSettings(() => {
    setAccountSettings({
      provider_dev: "OpenAI, CODEX",
      provider_artificer: "OpenAI",
      provider_researcher: "OpenAI",
      provider_planner: "OpenAI",
      provider_preflight: "OpenAI",
      provider_assessor: "OpenAI",
      provider_delegator: "OpenAI",
    });

    assert.deepEqual(getAvailableProviders("dev"), ["openai", "codex"]);
    const health = getProviderHealth();
    assert.equal(health.some((row) => row.provider === "openai"), true);
    assert.equal(health.some((row) => row.provider === "OpenAI"), false);
  }));

  it("supports the documented bare image conversion CLI form", (t) => {
    try {
      execFileSync("python", ["-c", "from PIL import Image"], { stdio: "ignore" });
    } catch {
      t.skip("Pillow is not available in this environment");
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-image-convert-"));
    try {
      const src = path.join(root, "input.png");
      const dst = path.join(root, "output.jpg");
      fs.writeFileSync(src, Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ));
      execFileSync("python", [
        path.resolve("tools", "convert_image.py"),
        src,
        dst,
        "--max-size",
        "1",
      ], { cwd: path.resolve("."), stdio: "pipe" });
      assert.equal(fs.existsSync(dst), true);
      assert.ok(fs.statSync(dst).size > 0);
    } finally {
      removeTempTree(root);
    }
  });

  it("keeps file helper support lists aligned with implemented parsers", () => {
    const convertFile = fs.readFileSync(path.resolve("tools", "convert_file.py"), "utf8");
    const parseFile = fs.readFileSync(path.resolve("tools", "parse_file.py"), "utf8");
    const convertImage = fs.readFileSync(path.resolve("tools", "convert_image.py"), "utf8");

    assert.doesNotMatch(convertFile, /PDF\s+->.*DOCX/i);
    assert.doesNotMatch(convertFile, /DOCX\s+->.*PDF/i);
    assert.doesNotMatch(convertFile, /\("\.xls"/);
    assert.doesNotMatch(parseFile, /"\.xls"/);
    assert.doesNotMatch(convertImage, /SVG \(read-only\)/);
  });

  it("does not truncate CSV passthrough output in parse_file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-parse-csv-"));
    try {
      const src = path.join(root, "large.csv");
      const rows = ["a,b"];
      for (let i = 0; i < 700; i += 1) rows.push(`${i},${"x".repeat(24)}`);
      const expected = `${rows.join("\n")}\n`;
      fs.writeFileSync(src, expected, "utf8");

      const output = execFileSync("python", [
        path.resolve("tools", "parse_file.py"),
        src,
        "--format",
        "csv",
      ], { cwd: path.resolve("."), encoding: "utf8" });

      assert.ok(output.includes("699,xxxxxxxxxxxxxxxxxxxxxxxx"));
      assert.ok(output.length >= expected.length);
    } finally {
      removeTempTree(root);
    }
  });

  it("preserves later-row keys during JSON to CSV conversion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-json-csv-"));
    try {
      const src = path.join(root, "input.json");
      const dst = path.join(root, "output.csv");
      fs.writeFileSync(src, JSON.stringify({
        rows: [
          { a: 1 },
          { a: 2, b: 3 },
        ],
      }), "utf8");

      execFileSync("python", [
        path.resolve("tools", "convert_file.py"),
        src,
        dst,
      ], { cwd: path.resolve("."), stdio: "pipe" });

      const output = fs.readFileSync(dst, "utf8").replace(/\r\n/g, "\n");
      assert.equal(output, "a,b\n1,\n2,3\n");
    } finally {
      removeTempTree(root);
    }
  });

  it("supports the documented JSON to XLSX file helper conversion", (t) => {
    try {
      execFileSync("python", ["-c", "import openpyxl"], { stdio: "ignore" });
    } catch {
      t.skip("openpyxl is not available in this environment");
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-json-xlsx-"));
    try {
      const src = path.join(root, "input.json");
      const dst = path.join(root, "output.xlsx");
      fs.writeFileSync(src, JSON.stringify({
        rows: [
          { name: "alpha", tokens: 12 },
          { name: "beta", tokens: 34 },
        ],
      }), "utf8");

      execFileSync("python", [
        path.resolve("tools", "convert_file.py"),
        src,
        dst,
      ], { cwd: path.resolve("."), stdio: "pipe" });

      const observed = execFileSync("python", [
        "-c",
        [
          "import json, sys, openpyxl",
          "wb = openpyxl.load_workbook(sys.argv[1], data_only=True)",
          "ws = wb.active",
          "print(json.dumps([list(row) for row in ws.iter_rows(values_only=True)]))",
        ].join("; "),
        dst,
      ], { encoding: "utf8" }).trim();

      assert.deepEqual(JSON.parse(observed), [
        ["name", "tokens"],
        ["alpha", 12],
        ["beta", 34],
      ]);
    } finally {
      removeTempTree(root);
    }
  });

  it("keeps runtime source free of common mojibake sequences", () => {
    const roots = [
      path.resolve("lib"),
      path.resolve("tools"),
      path.resolve("orchestrator.js"),
    ];
    const sourceExtensions = new Set([".js", ".mjs", ".py"]);
    const offenders = [];

    function visit(target) {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        if (path.basename(target) === "__pycache__") return;
        for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
        return;
      }
      if (!sourceExtensions.has(path.extname(target))) return;
      const text = fs.readFileSync(target, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (
          line.includes("\u00c3") ||
          line.includes("\ufffd") ||
          /\u00e2[\u0080-\uffff]/.test(line)
        ) {
          offenders.push(`${path.relative(path.resolve("."), target)}:${i + 1}`);
        }
      }
    }

    for (const root of roots) visit(root);
    assert.deepEqual(offenders, []);
  });

  it("writes installer env files with shell-safe literal helpers", () => {
    const linuxInstaller = fs.readFileSync(path.resolve("installers", "linux", "install-posse-atlas.sh"), "utf8");
    const windowsInstaller = fs.readFileSync(path.resolve("installers", "windows", "install-posse-atlas.ps1"), "utf8");

    assert.doesNotMatch(linuxInstaller, /eval\s+"\$@"/);
    assert.doesNotMatch(linuxInstaller, /run\s+"\(cd /);
    assert.match(linuxInstaller, /write_export\(\)/);
    assert.match(linuxInstaller, /printf 'export %s=%s\\n'/);
    assert.match(linuxInstaller, /source \$\(shell_quote "\$env_file"\)/);
    assert.match(linuxInstaller, /ensure_posse_alias\(\)/);
    assert.match(linuxInstaller, /POSSE_BIN_DIR/);

    assert.match(windowsInstaller, /function ConvertTo-PowerShellLiteral/);
    assert.match(windowsInstaller, /function Ensure-PosseAlias/);
    assert.match(windowsInstaller, /\$env:POSSE_ATLAS_INSTALL_PATH\s+= \{0\}/);
    assert.match(windowsInstaller, /\$env:POSSE_BIN_DIR\s+= \{0\}/);
    assert.doesNotMatch(windowsInstaller, /\$env:POSSE_ATLAS_INSTALL_PATH\s+= "\$AtlasDir"/);
    assert.match(windowsInstaller, /\$line = "\. \$\(ConvertTo-PowerShellLiteral \$EnvFile\)"/);
  });

  it("publishes both legacy and posse command names in package metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    assert.equal(pkg.bin["claude-org"], "./orchestrator.js");
    assert.equal(pkg.bin.posse, "./orchestrator.js");
  });

  it("blocks direct mutation attempts through deterministic bash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-bash-safety-"));
    try {
      const bash = createBashExecutor();
      assert.match(
        bash({ command: "mkdir created-by-bash" }, root),
        /Mutating command blocked/i,
      );
      assert.equal(fs.existsSync(path.join(root, "created-by-bash")), false);
      assert.match(
        bash({ command: 'node -e "require(\'fs\').writeFileSync(\'owned.txt\', \'nope\')"' }, root),
        /Mutating command blocked/i,
      );
      assert.equal(fs.existsSync(path.join(root, "owned.txt")), false);
      fs.writeFileSync(path.join(root, "writer.js"), "require('fs').writeFileSync('outside-scope.txt', 'nope')\n", "utf8");
      assert.match(
        bash({ command: "node writer.js" }, root),
        /Command not in allowlist/i,
      );
      assert.equal(fs.existsSync(path.join(root, "outside-scope.txt")), false);

      const policy = new MutationPolicy({ cwd: root });
      assert.equal(policy.authorizeBash("python -m pytest tests").ok, true);
      assert.equal(policy.authorizeBash("python build.py").ok, false);
    } finally {
      removeTempTree(root);
    }
  });

  it("allows image transforms when no writable scope is declared", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-image-unscoped-"));
    try {
      const input = path.join(root, "input.png");
      fs.writeFileSync(input, Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ));

      const toolkit = createDeterministicToolkit({ skipObservationLogging: true });
      const scope = buildScopePredicates(root, {});
      const output = toolkit.execResizeImage({
        path: "input.png",
        output_path: "output.png",
        width: 1,
        height: 1,
      }, root, scope);

      const parsed = JSON.parse(output);
      assert.equal(parsed.ok, true);
      assert.equal(fs.existsSync(path.join(root, "output.png")), true);
    } finally {
      removeTempTree(root);
    }
  });

  it("honors runtime path overrides set via setRuntimePathOverrides", async () => {
    const pathsMod = await import("../lib/domains/runtime/functions/paths.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-override-"));
    try {
      const overrides = {
        projectDir: path.join(root, "project"),
        runtimeRoot: path.join(root, "runtime"),
        dbPath: path.join(root, "runtime", "custom.db"),
        resourcesDir: path.join(root, "resources"),
        logDir: path.join(root, "logs"),
      };
      pathsMod.setRuntimePathOverridesForTests(overrides);
      assert.deepEqual(
        {
          project: pathsMod.normalizeProjectDir(),
          root: pathsMod.getRuntimeRoot(),
          db: pathsMod.getRuntimeDbPath(),
          resources: pathsMod.getRuntimeResourcesDir(),
          logs: pathsMod.getRuntimeLogDir(),
        },
        {
          project: path.resolve(overrides.projectDir),
          root: path.resolve(overrides.runtimeRoot),
          db: path.resolve(overrides.dbPath),
          resources: path.resolve(overrides.resourcesDir),
          logs: path.resolve(overrides.logDir),
        },
      );
    } finally {
      pathsMod.setRuntimePathOverridesForTests(null);
      removeTempTree(root);
    }
  });

  it("does not read runtime paths from environment variables", async () => {
    // Configuration policy: runtime paths are not env-var configurable.
    // Paths come from setRuntimePathOverrides (programmatic) or default
    // to <projectDir>/.posse. See CLAUDE.md "Configuration Policy".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-env-policy-"));
    try {
      const env = {
        ...process.env,
        POSSE_PROJECT_DIR: path.join(root, "should-be-ignored"),
        POSSE_RUNTIME_ROOT: path.join(root, "should-be-ignored-runtime-root"),
        POSSE_RUNTIME_LOG_DIR: path.join(root, "should-be-ignored-runtime-logs"),
        POSSE_RUNTIME_DIR: path.join(root, "should-be-ignored-too"),
        ORCHESTRATOR_DB: path.join(root, "should-be-ignored.db"),
        POSSE_RESOURCES_DIR: path.join(root, "ignored-resources"),
        POSSE_LOG_DIR: path.join(root, "ignored-logs"),
      };
      const observed = execFileSync(process.execPath, [
        "--input-type=module",
        "-e",
        "const p = await import('./lib/domains/runtime/functions/paths.js'); console.log(JSON.stringify({ project:p.normalizeProjectDir(), root:p.getRuntimeRoot(), db:p.getRuntimeDbPath(), resources:p.getRuntimeResourcesDir(), logs:p.getRuntimeLogDir() }));",
      ], { cwd: path.resolve("."), env, encoding: "utf8" }).trim();
      const parsed = JSON.parse(observed);
      const ignoredRoots = Object.values(env).filter((value) => String(value).includes("ignored") || String(value).includes("should-be-ignored"));
      for (const ignored of ignoredRoots) {
        for (const observedPath of Object.values(parsed)) {
          assert.equal(
            String(observedPath).includes(String(ignored)),
            false,
            `${observedPath} unexpectedly reflects env var ${ignored}`,
          );
        }
      }
    } finally {
      removeTempTree(root);
    }
  });

  it("passes intercepted console.error through to the original stderr handler", () => {
    const originalStdoutWrite = process.stdout.write;
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const captured = [];
    process.stdout.write = () => true;
    console.error = (...args) => captured.push(args);

    const display = new Display();
    display.addEvent = () => {};
    try {
      display.start();
      const err = new Error("boom");
      console.error(err, "context");
      assert.equal(captured.length, 1);
      assert.equal(captured[0][0], err);
      assert.equal(captured[0][1], "context");
    } finally {
      display.stop();
      process.stdout.write = originalStdoutWrite;
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }
  });

  it("does not break console wrappers installed after Display.start", () => {
    const originalStdoutWrite = process.stdout.write;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    process.stdout.write = () => true;

    const display = new Display();
    let eventCount = 0;
    display.addEvent = () => { eventCount += 1; };
    try {
      display.start();
      const displayConsoleLog = console.log;
      let wrapperCalls = 0;
      console.log = (...args) => {
        wrapperCalls += 1;
        displayConsoleLog(...args);
      };

      display.stop();
      console.log("after stop");

      assert.equal(wrapperCalls, 1);
      assert.equal(eventCount, 0);

      display.start();
      display.stop();
      console.log("after second stop");

      assert.equal(wrapperCalls, 2);
      assert.equal(eventCount, 0);
    } finally {
      display.stop();
      process.stdout.write = originalStdoutWrite;
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }
  });

  it("does not write alternate-screen escapes when stdout is not a TTY", () => {
    const originalStdoutWrite = process.stdout.write;
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const writes = [];
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    const display = new Display();
    display.addEvent = () => {};
    try {
      display.start();
      display.stop();
      const text = writes.join("");
      assert.doesNotMatch(text, /\x1b\[\?1049h/);
      assert.doesNotMatch(text, /\x1b\[\?1049l/);
    } finally {
      display.stop();
      process.stdout.write = originalStdoutWrite;
      if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
      else delete process.stdout.isTTY;
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }
  });

  it("keeps provider usage refresh failures inside Display", async () => {
    const display = new Display({
      providerUsageRefresh: async () => {
        throw new Error("usage backend exploded\nsecond line");
      },
    });

    await assert.doesNotReject(() => display._refreshProviderUsageForDisplay());
    assert.equal(display.events.length, 1);
    assert.match(display.events[0].text, /provider usage refresh unavailable: usage backend exploded/);

    await assert.doesNotReject(() => display._refreshProviderUsageForDisplay());
    assert.equal(display.events.length, 1);
  });

  it("resolvePathWithin blocks symlink/junction escapes, including missing children below the link", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scope-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scope-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "nope\n", "utf8");
      const link = path.join(root, "link");
      try {
        fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        t.skip(`symlink unavailable in this environment: ${err?.message || err}`);
        return;
      }

      assert.equal(resolvePathWithin(root, "link/secret.txt"), null);
      assert.equal(resolvePathWithin(root, "link/new-file.txt"), null);
      assert.equal(resolvePathWithin(root, "safe/new-file.txt"), path.join(root, "safe", "new-file.txt"));
    } finally {
      removeTempTree(root);
      removeTempTree(outside);
    }
  });

  it("treats wildcard create_roots as missing code scope", () => {
    assert.throws(() => assertHandoffScopePreflight({
      job_type: "dev",
      task_mode: "code",
      title: "wildcard write",
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      create_roots: ["."],
    }), /has no writable scope/);

    assert.doesNotThrow(() => assertHandoffScopePreflight({
      job_type: "dev",
      task_mode: "code",
      title: "scoped create",
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      create_roots: ["src/generated"],
    }));
  });

  it("filters file requests against normalized file and root scope", () => {
    const cwd = path.resolve(os.tmpdir(), "posse-scope-filter");
    const filtered = filterFileRequestsToOutOfScope([
      { path: "src/components/New Widget.jsx", risk: "mid" },
      { path: "src/components/extra.js", risk: "high" },
      { path: "docs/Guide.md", risk: "mid" },
      { path: "assets/icon.svg", risk: "low" },
      { path: "old/removed.js", risk: "high" },
    ], {
      files_to_create: ["src/components/New Widget.jsx"],
      files_to_modify: [path.join(cwd, "docs", "Guide.md")],
      create_roots: [path.join(cwd, "assets")],
    }, ["old/removed.js"], cwd);

    assert.deepEqual(filtered.map((entry) => entry.path), ["src/components/extra.js"]);
  });

  it("keeps mutating __test helpers unavailable outside node --test", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const script = `
      const helpers = [
        ["./lib/domains/queue/functions/index.js", "__testSetLeaseClockForTests", (fn) => fn(null)],
        ["./lib/domains/queue/functions/common.js", "__testSetNowClockForTests", (fn) => fn(null)],
        ["./lib/domains/providers/functions/provider.js", "__testResetProviderUsageAuthPrime", (fn) => fn()],
        ["./lib/domains/providers/functions/claude.js", "__testResetClaudeResolution", (fn) => fn()],
        ["./lib/domains/providers/functions/codex.js", "__testSetCodexUsageFetchers", (fn) => fn({})],
        ["./lib/domains/providers/functions/codex.js", "__testResetCodexUsageState", (fn) => fn()],
        ["./lib/domains/integrations/functions/atlas-embedded.js", "__testResetAtlasJobCache", (fn) => fn()],
        ["./lib/domains/observability/functions/observations.js", "__testSetObservationStreamWriterForTests", (fn) => fn(null)],
        ["./lib/domains/worker/functions/helpers/verdict-shared.js", "__testQueueInternalAssessmentRetry", (fn) => fn(null, null, "test")],
      ];
      const failures = [];
      for (const [specifier, name, call] of helpers) {
        const mod = await import(specifier);
        try {
          call(mod[name]);
          failures.push(name + " was not blocked");
        } catch (err) {
          if (!/test-only/.test(String(err?.message || err))) {
            failures.push(name + " failed for the wrong reason: " + String(err?.message || err));
          }
        }
      }
      if (failures.length > 0) {
        console.error(failures.join("\\n"));
        process.exit(1);
      }
      console.error("blocked " + helpers.length + " helpers");
      process.exit(7);
    `;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ], { cwd: POSSE_ROOT, env, encoding: "utf8" });

    assert.equal(child.status, 7);
    assert.match(child.stderr, /blocked 9 helpers/);
  });

  it("rejects dev planner create_roots that grant broad or unsafe scope", () => {
    const baseTask = {
      title: "Unsafe roots",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Create files",
      files_to_modify: [],
      files_to_create: ["src/new.js"],
      files_to_delete: [],
      success_criteria: ["done"],
      depends_on_index: [],
    };

    for (const root of [".", "*", "../outside", path.resolve(os.tmpdir(), "outside")]) {
      const errors = validatePlannedTask({ ...baseTask, create_roots: [root] }, 0, 1);
      assert.ok(errors.some((error) => error.startsWith("create_roots[0]")), `expected create_roots error for ${root}: ${errors.join("; ")}`);
    }

    assert.deepEqual(validatePlannedTask({ ...baseTask, create_roots: ["src/generated"] }, 0, 1), []);
  });

  it("rejects promote source directories outside the work item artifact root", { skip: nativeHeartbeatSkipReason() ?? false }, async () => withTempRuntimeDb(async (projectDir) => {
    // The promote worker probes git worktree state via a key-gated native
    // method; point in-process account settings at a seeded heartbeat db.
    const restoreHeartbeat = installNativeHeartbeatForProcess(path.join(projectDir, ".posse", "account-heartbeat.db"));
    try {
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
    fs.writeFileSync(path.join(projectDir, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

    const wi = createWorkItem("Reject unsafe promote", "desc");
    const artifactRoot = artifactsDir(wiScopeId(wi.id), projectDir);
    fs.mkdirSync(artifactRoot, { recursive: true });
    const sourceDir = path.join(projectDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "hero.png"), "png-data", "utf-8");

    const job = createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Unsafe promote",
      max_attempts: 1,
      payload_json: JSON.stringify({
        source_dir: sourceDir,
        mappings: [{ pattern: "hero.png", dest: "public/images" }],
      }),
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const leasedJob = getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new Worker({ projectDir, silent: true });
    await worker.execute(leasedJob);

    const refreshed = getJob(job.id);
    assert.equal(refreshed.status, "dead_letter");
    assert.match(refreshed.last_error || "", /Promote source directory must be inside/);
    assert.equal(fs.existsSync(path.join(projectDir, "public", "images", "hero.png")), false);
    const attempts = getAttempts(job.id);
    assert.match(attempts.at(-1)?.error_text || "", /Promote source directory must be inside/);
    } finally {
      restoreHeartbeat();
    }
  }));

  it("rejects protected promote destinations before copying artifacts", { skip: nativeHeartbeatSkipReason() ?? false }, async () => withTempRuntimeDb(async (projectDir) => {
    const restoreHeartbeat = installNativeHeartbeatForProcess(path.join(projectDir, ".posse", "account-heartbeat.db"));
    try {
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
    fs.writeFileSync(path.join(projectDir, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

    const wi = createWorkItem("Reject protected promote dest", "desc");
    const artifactRoot = artifactsDir(wiScopeId(wi.id), projectDir);
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, "hero.png"), "png-data", "utf-8");

    const job = createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Unsafe promote destination",
      max_attempts: 1,
      payload_json: JSON.stringify({
        source_dir: artifactRoot,
        mappings: [{ pattern: "hero.png", dest: "node_modules/pkg/hero.png" }],
      }),
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const leasedJob = getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new Worker({ projectDir, silent: true });
    await worker.execute(leasedJob);

    const refreshed = getJob(job.id);
    assert.equal(refreshed.status, "dead_letter");
    assert.match(refreshed.last_error || "", /promote destination is protected: dependency directories are protected/);
    assert.equal(fs.existsSync(path.join(projectDir, "node_modules", "pkg", "hero.png")), false);
    } finally {
      restoreHeartbeat();
    }
  }));

  it("quotes Codex MCP env override keys that are not bare TOML keys", () => {
    const previous = process.env["ProgramFiles(x86)"];
    process.env["ProgramFiles(x86)"] = "C:\\Program Files (x86)";
    try {
      const result = __testBuildCodexDeterministicReadConfigOverrides("dev", process.cwd());
      assert.ok(result.active, "deterministic MCP config should be active for dev jobs");
      assert.ok(
        result.configOverrides.some((line) => /^mcp_servers\.[^.]+\.env\."ProgramFiles\(x86\)"="C:\\\\Program Files \(x86\)"$/.test(line)),
        "expected Windows ProgramFiles(x86) env key to be TOML-quoted",
      );
      assert.equal(
        result.configOverrides.some((line) => /^mcp_servers\.[^.]+\.env\.ProgramFiles\(x86\)=/.test(line)),
        false,
      );
    } finally {
      if (previous == null) delete process.env["ProgramFiles(x86)"];
      else process.env["ProgramFiles(x86)"] = previous;
    }
  });

  it("does not spawn a second plan when iterative research already has a dependent plan", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Iterative bugsweep", "desc", "normal", {
      metadata: {
        iterate: true,
        workflow_mode: "bugfix",
        iteration: { active: true, pass_count: 1, max_passes: 3 },
      },
    });
    const research = createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (iterate 1): Iterative bugsweep",
      payload_json: JSON.stringify({
        _is_loopback: true,
        _iterate_pass: 1,
        workflow_mode: "bugfix",
      }),
    });
    const existingPlan = createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Iterate (bugfix pass 1): Iterative bugsweep",
      parent_job_id: research.id,
      payload_json: JSON.stringify({
        _is_loopback: true,
        _iterate_pass: 1,
        workflow_mode: "bugfix",
      }),
    });
    addDependency(existingPlan.id, research.id, "hard");

    const emitted = [];
    const result = spawnPlanAfterResearch({
      parsePayload: (job) => job?.payload_json ? JSON.parse(job.payload_json) : {},
      emit: (_jobId, message) => emitted.push(message),
    }, research, "# Research Brief\nNo human questions.\n");

    assert.equal(result.id, existingPlan.id);
    const plans = listJobsByWorkItem(wi.id).filter((job) => job.job_type === "plan");
    assert.deepEqual(plans.map((job) => job.id), [existingPlan.id]);
    assert.ok(emitted.some((message) => String(message).includes("skipping duplicate plan spawn")));
  }));

  it("merges an iterative pass before spawning the next research loop", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Iterative merge loop", "desc", "normal", {
      metadata: {
        iterate: true,
        workflow_mode: "bugfix",
        iteration: { active: true, pass_count: 0, max_passes: 3 },
      },
    });
    setWorkItemBranch(wi.id, "posse/wi-merge-loop", "base-sha");
    const dev = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Initial pass",
    });
    updateJobStatus(dev.id, "succeeded");
    updateWorkItemStatus(wi.id, "complete");

    const calls = [];
    const result = await processIterativeWrapUp({
      projectDir: "unused",
      reason: "test wrap-up",
      mergeIterativePassToTarget: async (workItem, opts) => {
        calls.push({ workItem, opts });
        return {
          ok: true,
          mergeHash: "abc1234567890",
          targetBranch: "main",
          sourceBranchTip: "def1234567890",
        };
      },
    });

    assert.equal(result.rerun, true);
    assert.equal(result.spawned, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workItem.branch_name, "posse/wi-merge-loop");
    assert.equal(calls[0].opts.passNumber, 0);

    const jobs = listJobsByWorkItem(wi.id);
    assert.equal(jobs.filter((job) => job.job_type === "research").length, 1);
    assert.equal(jobs.filter((job) => job.job_type === "plan").length, 1);

    const metadata = parseWorkItemMetadata(getWorkItem(wi.id));
    assert.equal(metadata.iteration.pass_count, 1);
    assert.equal(metadata.iteration.last_merged_pass, 0);
    assert.equal(metadata.iteration.last_merged_target_sha, "abc1234567890");
    assert.equal(metadata.iteration.last_merged_branch_tip, "def1234567890");
  }));

  it("blocks iterative next-pass spawn when the pass merge fails", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Iterative dirty target", "desc", "normal", {
      metadata: {
        iterate: true,
        workflow_mode: "bugfix",
        iteration: { active: true, pass_count: 0, max_passes: 3 },
      },
    });
    setWorkItemBranch(wi.id, "posse/wi-dirty-target", "base-sha");
    const dev = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Initial pass",
    });
    updateJobStatus(dev.id, "succeeded");
    updateWorkItemStatus(wi.id, "complete");

    const result = await processIterativeWrapUp({
      projectDir: "unused",
      reason: "test wrap-up",
      mergeIterativePassToTarget: async () => ({
        ok: false,
        dirty: true,
        targetBranch: "main",
        message: "target worktree has uncommitted changes",
      }),
    });

    assert.equal(result.rerun, false);
    assert.equal(result.spawned, 0);
    assert.equal(result.finalized, 1);
    const jobs = listJobsByWorkItem(wi.id);
    assert.equal(jobs.filter((job) => job.job_type === "research").length, 0);
    assert.equal(jobs.filter((job) => job.job_type === "plan").length, 0);

    const refreshed = getWorkItem(wi.id);
    assert.equal(refreshed.merge_state, "merge_failed");
    const metadata = parseWorkItemMetadata(refreshed);
    assert.equal(metadata.iteration.active, false);
    assert.match(metadata.iteration.stop_reason, /pass merge failed/);
  }));

  it("sanitizes terminal active iterative WIs with already-queued follow-up jobs", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Iterative startup sanitize", "desc", "normal", {
      metadata: {
        iterate: true,
        workflow_mode: "bugfix",
        iteration: { active: true, pass_count: 1, max_passes: 3 },
      },
    });
    const research = createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (iterate 1): Iterative startup sanitize",
      payload_json: JSON.stringify({ _is_loopback: true, _iterate_pass: 1 }),
    });
    const plan = createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Iterate (bugfix pass 1): Iterative startup sanitize",
      parent_job_id: research.id,
      payload_json: JSON.stringify({ _is_loopback: true, _iterate_pass: 1 }),
    });
    addDependency(plan.id, research.id, "hard");
    updateWorkItemMetadata(wi.id, {
      iterate: true,
      workflow_mode: "bugfix",
      iteration: {
        active: true,
        pass_count: 1,
        max_passes: 3,
        awaiting_research_job_id: research.id,
        awaiting_plan_job_id: plan.id,
      },
    });
    getDb().prepare(`
      UPDATE work_items
      SET status = 'complete',
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), wi.id);

    const result = await processIterativeWrapUp({
      projectDir: "unused",
      reason: "startup test",
      mergeIterativePassToTarget: async () => {
        throw new Error("merge should not run while follow-up jobs are queued");
      },
    });

    assert.equal(result.rerun, false);
    assert.equal(result.spawned, 0);
    assert.equal(getWorkItem(wi.id).status, "planning");
    const jobs = listJobsByWorkItem(wi.id);
    assert.deepEqual(jobs.map((job) => job.id), [research.id, plan.id]);
    const events = getEventsByWorkItem(wi.id, 10);
    assert.ok(events.some((event) => event.event_type === "work_item.iteration_startup_sanitized"));
  }));

  it("gates max-round self-resolve planning on the final human clarification", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Clarify before plan", "desc");
    const research = createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Clarify before plan",
      payload_json: JSON.stringify({
        _self_resolve: true,
        _clarification_round: 3,
        deepthink_budget: "normal",
      }),
    });
    const emitted = [];

    spawnPlanAfterResearch({
      parsePayload: (job) => job?.payload_json ? JSON.parse(job.payload_json) : {},
      emit: (_jobId, message) => emitted.push(message),
    }, research, [
      "# Research Brief",
      "",
      "Questions for Human",
      "Question: Which deployment window should the implementation target?",
    ].join("\n"));

    const jobs = listJobsByWorkItem(wi.id);
    const humanJob = jobs.find((job) => job.job_type === "human_input");
    const planJob = jobs.find((job) => job.job_type === "plan");
    assert.ok(humanJob, "expected a final human gate");
    assert.ok(planJob, "expected a plan job");
    assert.equal(planJob.parent_job_id, research.id);
    assert.equal(
      getDependencies(planJob.id).some((dep) =>
        Number(dep.depends_on_job_id) === Number(humanJob.id)
        && dep.dependency_kind === "hard"
      ),
      true,
    );
    assert.ok(emitted.some((message) => String(message).includes("gated by human_input")));
  }));

  it("accepts scoped paths from nested cwd when git reports repo-root-prefixed paths", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-nested-scope-"));
    const nestedRepoDir = path.join(repoRoot, "arbitrary-repo", "src");
    try {
      fs.mkdirSync(nestedRepoDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });

      const targetPath = path.join(nestedRepoDir, "scoped.txt");
      fs.writeFileSync(targetPath, "base\n", "utf-8");
      execFileSync("git", ["add", "arbitrary-repo/src/scoped.txt"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      fs.writeFileSync(targetPath, "changed\n", "utf-8");

      const result = gitCommitAll("nested scope fix", path.join(repoRoot, "arbitrary-repo"), {
        modifyFiles: ["src/scoped.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir: repoRoot,
        wiId: 991,
        branchName: "posse/test-nested-scope",
      });

      assert.equal(result.scopeCleanedNoOp, false);
      assert.equal(fs.readFileSync(targetPath, "utf-8").replace(/\r\n/g, "\n"), "changed\n");
      const committedFiles = execFileSync(
        "git",
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        { cwd: repoRoot, encoding: "utf-8" },
      ).split("\n").map((s) => s.trim()).filter(Boolean);
      assert.ok(committedFiles.includes("arbitrary-repo/src/scoped.txt"));
      assert.equal(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim(),
        "2",
      );
    } finally {
      removeTempTree(repoRoot);
    }
  });

  it("keeps nested worktree runtime locks out of git status", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-nested-worktree-lock-"));
    const projectDir = path.join(repoRoot, "apps", "demo");
    const wtDir = path.join(projectDir, ".posse-worktrees", "wi-1");
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "README.md"), "base\n", "utf-8");
      execFileSync("git", ["add", "apps/demo/README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      execFileSync("git", ["worktree", "add", "-b", "posse/wi-1", wtDir], { cwd: repoRoot, stdio: "ignore" });
      const scopedPath = configureWorktreeScope(wtDir, projectDir);
      fs.mkdirSync(path.join(wtDir, ".posse"), { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".posse", "active-job"), "{}\n", "utf-8");
      fs.writeFileSync(path.join(scopedPath, "README.md"), "changed\n", "utf-8");

      const resetIncomplete = [];
      snapshotAndResetDirtyWorktree(scopedPath, projectDir, {
        reason: "nested-runtime-lock-regression",
        branchName: "posse/wi-1",
        wiId: 1,
        onResetIncomplete: ({ remainingPaths = [] }) => resetIncomplete.push(...remainingPaths),
      });

      assert.deepEqual(resetIncomplete, []);
      assert.equal(fs.existsSync(`${scopedPath}.lock`), false);
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: scopedPath,
        encoding: "utf-8",
      }).trim();
      assert.equal(status, "");
    } finally {
      removeTempTree(repoRoot);
    }
  });

  it("excludes already-merged work items from human review even if branch metadata remains", () => {
    const mergedWithBranch = {
      id: 16,
      status: "complete",
      branch_name: "posse/wi-16-example",
      merge_state: "merged",
    };
    const mergedWithBranchJobs = [{ job_type: "dev", status: "succeeded" }];
    assert.equal(shouldIncludeWorkItemInApprovalQueue(mergedWithBranch, mergedWithBranchJobs), false);

    const pendingReview = {
      id: 17,
      status: "complete",
      branch_name: "posse/wi-17-example",
      merge_state: "pending_review",
    };
    assert.equal(shouldIncludeWorkItemInApprovalQueue(pendingReview, mergedWithBranchJobs), true);
    assert.equal(
      shouldIncludeWorkItemInApprovalQueue(
        { ...pendingReview, merge_state: "merge_failed" },
        mergedWithBranchJobs,
        { hasMergedEvent: true },
      ),
      false,
    );

    const researchOnly = {
      id: 18,
      status: "complete",
      branch_name: null,
      merge_state: null,
    };
    assert.equal(shouldIncludeWorkItemInApprovalQueue(researchOnly, [{ job_type: "research", status: "succeeded" }]), false);
    assert.equal(shouldIncludeWorkItemInApprovalQueue(researchOnly, mergedWithBranchJobs), false);

    const failedResearchOnly = {
      id: 19,
      status: "failed",
      branch_name: null,
      merge_state: null,
    };
    assert.equal(shouldIncludeWorkItemInApprovalQueue(failedResearchOnly, [{ job_type: "research", status: "failed" }]), false);
  });

  it("skips ATLAS boot indexing when v2 is disabled", async () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "on",
      POSSE_ATLAS_V2: "off",
      POSSE_ATLAS_PHASES: "research",
    });
    const report = await ensureAtlasRepoIndexedOnBoot({
      cwd: process.cwd(),
      config,
      execImpl() {
        throw new Error("disabled ATLAS should not index");
      },
    });

    assert.deepEqual(report, { attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" });
  });

  it("uses incremental ATLAS boot warm when an existing main view is stale", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-boot-stale-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "app.js"), "export const app = 1;\n");
      execFileSync("git", ["add", "src/app.js"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      const config = getAtlasIntegrationConfig({
        mode: "on",
        atlasV2Mode: "on",
        phases: "research",
        requestedRepoPath: repoRoot,
        bootReindexPolicy: "smart",
        scipMode: "off",
        vectorBackend: "off",
      });
      const first = await ensureAtlasRepoIndexedOnBoot({ cwd: repoRoot, config, timeoutMs: 30_000 });
      assert.equal(first.attempted, true);
      assert.equal(first.ok, true);
      assert.equal(first.result?.purpose, "main-full");

      const viewBefore = View.mount({ dbPath: mainViewPath(repoRoot) });
      const viewSeqBefore = viewBefore.meta().ledger_seq;
      viewBefore.close();

      const laterContent = "export const later = 2;\n";
      const laterHash = sha256Hex(Buffer.from(laterContent));
      fs.writeFileSync(path.join(repoRoot, "src", "later.js"), laterContent);
      const ledger = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
      try {
        ledger.ingestBlob({
          content_hash: laterHash,
          lang: "javascript",
          byte_size: Buffer.byteLength(laterContent),
          symbols: [],
          edges: [],
        });
        ledger.append({
          branch: "main",
          op: "add",
          repo_rel_path: "src/later.js",
          before_content_hash: null,
          after_content_hash: laterHash,
        });
        assert.equal(ledger.headSeq("main"), viewSeqBefore + 1);
      } finally {
        ledger.close();
      }

      const second = await ensureAtlasRepoIndexedOnBoot({ cwd: repoRoot, config, timeoutMs: 30_000 });
      assert.equal(second.attempted, true);
      assert.equal(second.ok, true);
      assert.equal(second.result?.purpose, "main-incremental");

      const viewAfter = View.mount({ dbPath: mainViewPath(repoRoot) });
      try {
        assert.equal(viewAfter.meta().ledger_seq, viewSeqBefore + 1);
      } finally {
        viewAfter.close();
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("includes purpose when a concurrent ATLAS boot warm finds the view already present", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-boot-race-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "app.js"), "export const app = 1;\n");
      execFileSync("git", ["add", "src/app.js"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      const config = getAtlasIntegrationConfig({
        mode: "on",
        atlasV2Mode: "on",
        phases: "research",
        requestedRepoPath: repoRoot,
        bootReindexPolicy: "smart",
        scipMode: "off",
        vectorBackend: "off",
      });
      const first = await ensureAtlasRepoIndexedOnBoot({ cwd: repoRoot, config, timeoutMs: 30_000 });
      assert.equal(first.attempted, true);
      assert.equal(first.ok, true);
      assert.equal(first.result?.purpose, "main-full");

      const viewBefore = View.mount({ dbPath: mainViewPath(repoRoot) });
      const viewSeqBefore = viewBefore.meta().ledger_seq;
      viewBefore.close();

      const raceContent = "export const race = 2;\n";
      const raceHash = sha256Hex(Buffer.from(raceContent));
      fs.writeFileSync(path.join(repoRoot, "src", "race.js"), raceContent);
      const ledger = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
      try {
        ledger.ingestBlob({
          content_hash: raceHash,
          lang: "javascript",
          byte_size: Buffer.byteLength(raceContent),
          symbols: [],
          edges: [],
        });
        ledger.append({
          branch: "main",
          op: "add",
          repo_rel_path: "src/race.js",
          before_content_hash: null,
          after_content_hash: raceHash,
        });
        assert.equal(ledger.headSeq("main"), viewSeqBefore + 1);
      } finally {
        ledger.close();
      }

      let resolveWorkerBusy;
      const workerBusy = new Promise((resolve) => { resolveWorkerBusy = resolve; });
      const firstConcurrent = ensureAtlasRepoIndexedOnBoot({
        cwd: repoRoot,
        config,
        timeoutMs: 30_000,
        __testWorkerBlockMs: 3_000,
        onProgress(event) {
          if (String(event?.text || "").includes("worker busy")) resolveWorkerBusy();
        },
      });
      await Promise.race([
        workerBusy,
        firstConcurrent.then((report) => {
          throw new Error(`first ATLAS boot warm finished before the worker busy progress event: ${JSON.stringify(report)}`);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for ATLAS boot worker busy progress")), 5_000)),
      ]);

      const secondConcurrent = ensureAtlasRepoIndexedOnBoot({ cwd: repoRoot, config, timeoutMs: 30_000 });
      const reports = await Promise.all([firstConcurrent, secondConcurrent]);
      for (const report of reports) {
        assert.equal(report.attempted, true);
        assert.equal(report.ok, true, JSON.stringify(report));
      }
      for (const report of reports) {
        assert.equal(report.result?.purpose, "main-incremental", JSON.stringify(reports.map((row) => row.result)));
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses incremental ATLAS boot warm when SCIP is staged for an existing view", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-boot-smart-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "app.js"), "export const app = 1;\n");
      execFileSync("git", ["add", "src/app.js"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      const baseConfig = {
        mode: "on",
        atlasV2Mode: "on",
        phases: "research",
        requestedRepoPath: repoRoot,
        bootReindexPolicy: "smart",
        scipRestagePolicy: "missing",
        vectorBackend: "off",
      };
      const first = await ensureAtlasRepoIndexedOnBoot({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({ ...baseConfig, scipMode: "off" }),
        timeoutMs: 30_000,
      });
      assert.equal(first.attempted, true);
      assert.equal(first.ok, true);
      assert.equal(first.result?.purpose, "main-full");

      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "from-scip.txt"), "export const fromScip = 1;\n");
      const symbol = "scip-typescript npm pkg 1.0.0 src/`from-scip.txt`/fromScip.";
      fs.writeFileSync(path.join(scipDir, "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/from-scip.txt",
          occurrences: [{ range: [0, 13, 21], symbol, symbol_roles: 0x1 }],
          symbols: [{ symbol, display_name: "fromScip" }],
        }],
      }));

      const second = await ensureAtlasRepoIndexedOnBoot({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({ ...baseConfig, scipMode: "on" }),
        timeoutMs: 30_000,
      });
      assert.equal(second.attempted, true);
      assert.equal(second.ok, true);
      assert.equal(second.result?.purpose, "main-incremental");
      assert.equal(second.result?.paths_considered, 0);
      assert.equal(second.result?.ledger_entries_appended, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retries missing SCIP staging on boot even when the main ATLAS view is current", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-boot-scip-retry-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      const pySource = "def from_scip():\n    return 1\n";
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "src", "app.py"), pySource);
      execFileSync("git", ["add", "pyproject.toml", "src/app.py"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

      const baseConfig = {
        mode: "on",
        atlasV2Mode: "on",
        phases: "research",
        requestedRepoPath: repoRoot,
        bootReindexPolicy: "smart",
        vectorBackend: "off",
      };
      const first = await ensureAtlasRepoIndexedOnBoot({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({ ...baseConfig, scipMode: "off" }),
        timeoutMs: 30_000,
      });
      assert.equal(first.attempted, true);
      assert.equal(first.ok, true);
      assert.equal(first.result?.purpose, "main-full");

      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(repoRoot, "node_modules", ".bin");
      fs.mkdirSync(binDir, { recursive: true });
      const symbol = "scip-python python fixture 1.0.0 src/`app.py`/from_scip().";
      const scipBytes = encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-python", version: "0.1.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "Python",
          relative_path: "src/app.py",
          occurrences: [{ range: [0, 4, 13], symbol, symbol_roles: 0x1 }],
          symbols: [{ symbol, display_name: "from_scip" }],
        }],
      }).toString("base64");
      fs.writeFileSync(path.join(binDir, "scip-python.mjs"), [
        "import fs from 'node:fs';",
        `const bytes = Buffer.from(${JSON.stringify(scipBytes)}, 'base64');`,
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "fs.writeFileSync(out, bytes);",
      ].join("\n"));
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(binDir, "scip-python.cmd"), "@echo off\r\nnode \"%~dp0scip-python.mjs\" %*\r\n");
      } else {
        const command = path.join(binDir, "scip-python");
        fs.writeFileSync(command, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/scip-python.mjs\" \"$@\"\n");
        fs.chmodSync(command, 0o755);
      }

      const progress = [];
      const second = await ensureAtlasRepoIndexedOnBoot({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({
          ...baseConfig,
          scipMode: "on",
          scipLanguages: "python",
          scipRestagePolicy: "missing",
          scipIndexTimeoutMs: 1000,
          scipColdIndexTimeoutMs: 30_000,
        }),
        timeoutMs: 30_000,
        onProgress: (event) => {
          if (event?.stage === "scip" && event?.text) progress.push(String(event.text));
        },
      });

      assert.equal(second.attempted, true);
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(second.result?.purpose, "main-incremental");
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), true);
      assert.ok(progress.some((line) => /retrying missing staging/.test(line)), progress.join("\n"));
      const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
      try {
        const rows = led.listScipIndexes();
        assert.equal(rows.some((row) => row.scheme === "scip-python"), true, JSON.stringify(rows));
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("replaces stale SDL post-commit hook block with managed ATLAS hook", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-hook-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      const hooksDir = path.join(repoRoot, ".git", "hooks");
      const hookPath = path.join(hooksDir, "post-commit");
      const staleHook = [
        "#!/bin/sh",
        "",
        "# >>> POSSE SDL REINDEX (managed) >>>",
        "echo stale-sdl",
        "node 'C:/development/claude/tools/posse/lib/functions/integrations/sdl-post-commit.js'",
        "exit 0",
        "# <<< POSSE SDL REINDEX (managed) <<<",
        "",
        "# >>> POSSE PROJECT MAP (managed) >>>",
        "echo project-map",
        "# <<< POSSE PROJECT MAP (managed) <<<",
        "",
      ].join("\n");
      fs.writeFileSync(hookPath, staleHook, "utf8");

      const report = ensureAtlasCommitReindexHook({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({
          mode: "on",
          atlasV2Mode: "on",
          phases: "research",
          reindexOnCommit: true,
          requestedRepoPath: repoRoot,
          vectorBackend: "off",
        }),
      });

      assert.equal(report.attempted, true);
      assert.equal(report.ok, true);
      assert.equal(report.changed, true);
      assert.equal(report.installed, true);
      assert.equal(report.legacySdlRemoved, true);

      const hook = fs.readFileSync(hookPath, "utf8");
      assert.doesNotMatch(hook, /POSSE SDL REINDEX/);
      assert.doesNotMatch(hook, /sdl-post-commit\.js/);
      assert.match(hook, /POSSE PROJECT MAP/);
      assert.match(hook, /POSSE ATLAS REINDEX/);
      assert.match(hook, /atlas-post-commit\.js/);
      assert.doesNotMatch(hook, /exit 0\n# <<< POSSE SDL REINDEX/);

      const second = ensureAtlasCommitReindexHook({
        cwd: repoRoot,
        config: getAtlasIntegrationConfig({
          mode: "on",
          atlasV2Mode: "on",
          phases: "research",
          reindexOnCommit: true,
          requestedRepoPath: repoRoot,
          vectorBackend: "off",
        }),
      });
      assert.equal(second.ok, true);
      assert.equal(second.changed, false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch honors target_branch before branch detection", async () => withTempRuntimeDb(async (runtimeRoot) => {
    const { resolveTargetBranch } = await import("../lib/domains/git/functions/worktree.js");
    const repoRoot = path.join(runtimeRoot, "target-branch-repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n", "utf-8");
    execFileSync("git", ["add", "base.txt"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["branch", "release/env"], { cwd: repoRoot, stdio: "ignore" });
    setSetting("target_branch", "release/env", { projectDir: repoRoot });
    assert.equal(resolveTargetBranch(repoRoot, targetBranchNativeParity()), "release/env");
  }));

  it("escalates parse-error assessment retries and persists the assess-only tier override", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("parse retry", "exercise internal assessor retry");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Parse retry job",
      model_tier: "cheap",
      max_attempts: 3,
      payload_json: JSON.stringify({ task_spec: "return valid assessor JSON" }),
    });

    assert.equal(
      __testQueueInternalAssessmentRetry(job, { verdict: "parse_error" }, "bad JSON", { maxRetries: 2 }),
      true,
    );

    const fresh = getJob(job.id);
    const payload = JSON.parse(fresh.payload_json);
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.model_tier, "standard");
    assert.equal(payload._assess_only, true);
    assert.equal(payload._assess_model_tier, "standard");
    const event = getEvents(job.id, 10).find((e) => e.event_type === "job.assessment_internal_retry");
    assert.match(event.message, /cheap -> standard/);
  }));

  it("skips internal assessment retry when the job payload is invalid JSON", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("bad retry payload", "exercise invalid assessor retry payload");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Bad payload retry job",
      model_tier: "cheap",
      max_attempts: 3,
      payload_json: JSON.stringify({ task_spec: "initially valid" }),
    });
    // Simulate a pre-migration corrupt row; new writes are now guarded by JSON
    // validity triggers, but recovery code still needs to tolerate legacy data.
    const db = getDb();
    db.exec(`DROP TRIGGER IF EXISTS posse_json_valid_jobs_payload_json_update`);
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run("{not-json", job.id);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
    job.payload_json = "{not-json";

    assert.equal(
      __testQueueInternalAssessmentRetry(job, { verdict: "parse_error" }, "bad JSON", { maxRetries: 2 }),
      false,
    );

    const fresh = getJob(job.id);
    assert.equal(fresh.model_tier, "cheap");
    assert.equal(fresh.payload_json, "{not-json");
    const events = getEvents(job.id, 10);
    assert.ok(events.some((e) => e.event_type === "job.assessment_retry_payload_parse_failed"));
    assert.equal(events.some((e) => e.event_type === "job.assessment_internal_retry"), false);
  }));

  it("renders ATLAS preferred tools using the provider-visible embedded names", () => {
    const text = renderAtlasHandoffSections({
      atlas: {
        active: true,
        provider: "openai",
        transport: "embedded",
        phase: "research",
        repo: { repoPath: process.cwd() },
        tools: ["context", "repo.status", "context.summary", "symbol.getCard"],
      },
    });

    assert.match(text, /Preferred ATLAS tools: atlas_context, atlas_repo_status, atlas_context_summary, atlas_symbol_get_card/);
    assert.doesNotMatch(text, /Preferred ATLAS tools: context/);
    assert.match(text, /start with atlas_context_summary \/ atlas_context \/ atlas_symbol_get_card/);
  });

  it("renders Codex ATLAS preferred tools with MCP names", () => {
    const text = renderAtlasHandoffSections({
      atlas: {
        active: true,
        provider: "codex",
        transport: "mcp",
        phase: "research",
        repo: { repoPath: process.cwd() },
        tools: ["context", "repo.status", "context.summary", "symbol.getCard"],
      },
    });

    assert.match(text, /Preferred ATLAS tools: atlas\.context, atlas\.repo\.status, atlas\.context\.summary, atlas\.symbol\.getCard/);
    assert.doesNotMatch(text, /Preferred ATLAS tools: atlas_context/);
    assert.match(text, /start with atlas\.context\.summary \/ atlas\.context \/ atlas\.symbol\.getCard/);
  });

  it("bounds tool replay cache buckets and per-job fingerprints", () => {
    __testResetToolReplayCache();
    try {
      const now = Date.now();
      for (let i = 0; i < 600; i += 1) {
        __testRememberToolReplayFingerprint(`job-${i}`, `tool.read|${i}`, now + i);
      }
      assert.ok(__testToolReplayCacheStats().buckets <= 512);

      for (let i = 0; i < 320; i += 1) {
        __testRememberToolReplayFingerprint("active-job", `tool.read|active-${i}`, now + 1000 + i);
      }
      const stats = __testToolReplayCacheStats();
      assert.ok(stats.buckets <= 512);
      assert.ok(stats.maxBucketSize <= 256);
    } finally {
      __testResetToolReplayCache();
    }
  });

  it("recordObservation returns false instead of throwing when detail serialization fails", () => withTempRuntimeDb(() => {
    const detail = {};
    detail.self = detail;
    assert.equal(recordObservation({
      observation_type: "test.circular",
      summary: "circular detail",
      detail,
    }), false);
  }));

  it("surfaces observation stream write failures while preserving DB observations", () => withTempRuntimeDb(() => {
    try {
      __testResetObservationStreamForTests();
      __testSetObservationStreamWriterForTests(() => {
        const err = new Error("simulated observation log failure");
        err.code = "ENOSPC";
        throw err;
      });

      assert.equal(recordObservation({
        observation_type: "test.stream_failure",
        summary: "stream failure is visible",
        detail: "plain string detail",
      }), true);

      const row = getDb().prepare(`
        SELECT detail_json FROM job_observations WHERE observation_type = 'test.stream_failure'
      `).get();
      assert.equal(JSON.parse(row.detail_json), "plain string detail");

      const state = __testGetObservationStreamStateForTests();
      assert.ok(state.disabledUntilMs > Date.now());
      assert.equal(state.lastFailure.phase, "write");
      assert.equal(state.lastFailure.code, "ENOSPC");
    } finally {
      __testResetObservationStreamForTests();
    }
  }));

  it("never renders credential values in the admin settings tab", () => {
    const token = "oauth-token-secret-value";
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    try {
      const tui = new AdminTUI({ projectDir: process.cwd() });
      tui._settingsPane = "providers";
      const plain = tui._buildSettings(158).map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ""));
      const keyLine = plain.find((line) => line.includes("CLAUDE_CODE_OAUTH_TOKEN"));
      assert.ok(keyLine, "credential key row should be listed");
      assert.match(keyLine, /configured/);
      // Neither the full secret nor any prefix of it may appear anywhere.
      assert.equal(plain.some((line) => line.includes(token)), false);
      assert.equal(plain.some((line) => line.includes("oauth-to")), false);
    } finally {
      if (original == null) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });
});
