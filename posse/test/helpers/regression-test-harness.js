import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb } from "../../lib/shared/storage/functions/index.js";
import { setRuntimePathOverridesForTests } from "../../lib/domains/runtime/functions/paths.js";
import {
  closeAccountSettingsDb,
  setAccountSettingsPathForTests,
} from "../../lib/domains/settings/functions/account-settings.js";

const TRANSIENT_CLEANUP_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

export function removeTempTree(target) {
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
}

export function withTempRuntimeDb(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-regression-db-"));
  const accountDbPath = path.join(root, ".posse", "account.db");
  closeDb();
  closeAccountSettingsDb();
  setRuntimePathOverridesForTests({
    projectDir: root,
    runtimeRoot: path.join(root, ".posse"),
    dbPath: path.join(root, ".posse", "db", "orchestrator.db"),
  });
  setAccountSettingsPathForTests(accountDbPath);
  const cleanup = () => {
    closeDb();
    closeAccountSettingsDb();
    setRuntimePathOverridesForTests(null);
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

export function withCapturedProcessSignals(fn) {
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

export function createRunSessionBootTestDeps(overrides = {}) {
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
    guardStartupDirtyTree: () => ({ ok: true, dirty: false, action: "clean" }),
    ensureBootDependenciesInWorker: async () => ({ ok: true, counts: { checked: 0, installed: 0, dry_run: 0, failed: 0, ready: 0 } }),
    formatBootDependencySync: () => "ready",
    NO_TUI: true,
    Scheduler: DefaultScheduler,
    primeProviderUsageAuth: () => ({ attempted: false, providers: [] }),
    getProviderHealth: () => [],
    PROJECT_DIR: process.cwd(),
    getConfiguredProviderUsageAsync: async () => [],
    startupWorktreeCleanup: () => {},
    ensureAtlasCommitReindexHook: () => ({ attempted: false }),
    getAtlasIntegrationConfig: () => ({}),
    ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
    disableAtlasForRun: () => {},
    enqueueAtlasSelfRepair: () => ({ ok: true, summary: "all layers ready", layers: [], actions: [] }),
    setConductorKeepWarm: () => {},
    closeSharedConductor: async () => {},
    setOnnxDaemonKeepWarm: () => {},
    closeSharedOnnxDaemon: async () => {},
    nativeBinaries: { workerFallbackStats: () => ({ total: 0, byBinary: {} }) },
    daemonSupervisor: { shutdownAll: async () => ({ reaped: 0 }) },
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
    hasAutoMergeableCompletedWorkItems: () => false,
    autoMergePendingReviewBlockers: false,
    describePendingReviewLockBlockers: () => null,
    wrapUpTui: async () => ({ rerun: false }),
    wrapUp: async () => ({ rerun: false }),
    offerPush: async () => {},
    exitProcess: () => {},
    ...overrides,
  };
}

export function seedAccountSetting(dbPath, key, value) {
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

export function withTempAccountSettings(fn) {
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
