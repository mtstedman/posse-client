// test/core.test.js — Unit tests for correctness-critical paths
//
// Uses node:test (zero dependencies). Run with:
//   node --test test/core.test.js
//
// Tests use an in-memory SQLite database — no disk, no side effects.

import { describe, it as nodeIt, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import http from "node:http";
import os from "os";
import path from "path";
import { EventEmitter } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import { closeAccountSettingsDb, setAccountSettings, setAccountSettingsPathForTests } from "../../../lib/domains/settings/functions/account-settings.js";
import { invalidateRemoteModelCatalog } from "../../../lib/domains/providers/functions/model-catalog-store.js";
import { setRuntimePathOverridesForTests } from "../../../lib/domains/runtime/functions/paths.js";
import { setDaemonLedgerDirForTests } from "../../../lib/classes/tools/daemon/index.js";
import { providerUsageRuntimeCache } from "../../../lib/domains/providers/classes/usage-runtime-cache-singleton.js";
import { __testResetProviderUsageAuthPrime, getAvailableProviders, getConfiguredProviderUsage, getProvider, getProviderBackoff, getProviderCapacityState, getProviderHealth, getProviderMap, getProviderName, getProviderRateLimitState, getProviderAtlasMap, getProviderAtlasSupport, getProviderTierInfo, getProviderUsage, getProviderUsageAsync, inferProviderWindowLimit, isMultiProvider, isProviderReady, isProviderSelectable, needsDelegation, primeProviderUsageAuth, primeProviderUsageAuthAsync, providerSupportsAtlas, selectProviderName, tierModelName } from "../../../lib/domains/providers/functions/provider.js";
import {
  applyAtlasBootEnv,
  buildAtlasCapability,
  buildAtlasBootEnv,
  buildAtlasIntegrationPlan,
  buildAtlasMcpServerConfig,
  buildAtlasServerSpec,
  buildAtlasIndexInvocation,
  buildWorkItemAtlasConfig,
  ensureAtlasCommitReindexHook,
  ensureAtlasRepoIndexedOnBoot,
  ensureWorkItemAtlasJoin,
  reindexAtlasAfterCommit,
  getAtlasIntegrationConfig,
  getAtlasRouteForRole,
  resolveAtlasRepoTarget,
  resolveAtlasGraphDbPath,
  resolveWorkItemAtlasGraphDbPath,
  resolveAtlasExecutionAttachment,
  seedWorkItemAtlasGraphFromPrimary,
  shouldUseAtlasInLiveFunnel,
  summarizeAtlasIntegrationPlan,
  isAtlasGraphCorruptionError,
  attemptAtlasGraphRecovery,
  __resetAtlasRuntimeDisabledForTests,
  disableAtlasForRun,
  getAtlasRuntimeDisabledReason,
  isAtlasRuntimeDisabled,
} from "../../../lib/domains/integrations/functions/atlas.js";
import {
  buildAtlasSmokeConfig,
  readConfiguredAtlasRepos,
  runAtlasSmokeTest,
} from "../../../lib/domains/integrations/functions/atlas-smoke.js";
import {
  ensureProjectMap,
  ensureProjectMapRebuildHook,
  generateProjectMap,
  getCachedProjectMap,
} from "../../../lib/domains/project/functions/map.js";
import {
  buildLockedToolError as buildGateLockedToolError,
  checkNativeToolAllowed,
  configureGate,
  getFallbackStrikeLimit,
  getMeaningfulAtlasCalls,
  getRequiredMeaningfulAtlasCalls,
  getUnhelpfulStrikes,
  getUnlockReason,
  isFallbackAtlasPrefetchStatus,
  isRelevantAtlasPrefetchStatus,
  isGateActive,
  isFileDiscoveredForGate,
  isGatedTool,
  isUnlocked as isGateUnlocked,
  noteAtlasCall,
  unlockForAtlasPrefetch,
  unlockForAtlasUnavailable,
  __resetGateForTests,
} from "../../../lib/domains/integrations/functions/deterministic-mcp/gate.js";
import {
  buildFoldedAtlasToolDescriptor,
  buildNativeToolDescriptor,
  isBlockedFoldedAtlasTool,
} from "../../../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { jobNeedsGitWorktree, jobsNeedGitWorktree } from "../../../lib/domains/git/functions/policy.js";
import { normalizeIntakeHints, buildIntakeHintsBlock, buildResearchIntakePreload } from "../../../lib/domains/worker/functions/helpers/intake-hints.js";
import {
  getResearchBudget,
  isDeepthinkTask,
  researchBudgetToReasoningEffort,
} from "../../../lib/domains/worker/functions/helpers/role-utils.js";
import {
  collectHandledSuggestionKeys,
  createApprovedSuggestionFollowUp,
  suggestionDecisionEventJson,
  suggestionDevJobDecision,
  suggestionReviewKey,
} from "../../../lib/domains/worker/functions/helpers/suggestions.js";
import { sanitizeHumanQuestions, isRepoFileAccessQuestion } from "../../../lib/domains/worker/functions/helpers/human-question-classifier.js";
import { inferPromoteTask, normalizePromoteMappings } from "../../../lib/domains/worker/functions/helpers/plan-routing.js";
import { isUnderRoot, normPath, normalizeRoots } from "../../../lib/domains/worker/functions/helpers/scope.js";
import { gitCommitAll } from "../../../lib/domains/git/functions/commit-scope.js";
import { buildInventory as buildCleanupInventory, inventoryIsEmpty as cleanupInventoryIsEmpty, inventorySummary as cleanupInventorySummary } from "../../../lib/domains/cleanup/functions/survey.js";
import { buildItemIndex as buildCleanupItemIndex, deterministicFallback as cleanupDeterministicFallback } from "../../../lib/domains/cleanup/functions/triage.js";
import { applyAction as applyCleanupAction, discardSnapshot as discardCleanupSnapshot, discardWorktree as discardCleanupWorktree } from "../../../lib/domains/cleanup/functions/actions.js";
import { escalateTier, extractJson, parseErrorBackoff, setClaudeConfigDirForTests, warmOauthSession } from "../../../lib/domains/providers/functions/claude.js";
import { handoff, parseMissingContext, parseFileRequest, classifyFileRisk, splitFileRequestsByRisk, parseResearcherStructuredOutput, extractResearcherFiles, normalizeResearcherFilePriorities, researcherOutputNeedsHuman, _parseFunctions, _buildSmartPreload } from "../../../lib/domains/handoff/functions/index.js";
import { renderAtlasHandoffSections } from "../../../lib/domains/handoff/functions/helpers/atlas-context.js";
import {
  clearSkillRegistryCache,
  getEnabledSkillsForRole,
  loadSkillManifests,
  validateSkillIds,
} from "../../../lib/shared/skills/functions/registry.js";
import { setActivePromptBundleForTest } from "../../../lib/domains/remote/functions/prompt-bundle.js";
import { reloadArtifactProtocols, getArtifactProtocol, getResolvedImageProtocol, validateManifestAgainstContract, injectArtifactScope, normalizeArtifactCreateFiles, buildManifest, cleanupArtifactDirs, pruneEmptyArtifactDirs, artifactsDir, inputsDir, workspaceDir, contextDir, wiScopeId, workItemArtifactRoot, artifactTaskOutputRoot } from "../../../lib/domains/artifacts/functions/index.js";
import { AdminTUI, canUseAdminTui, purgeRuntimeLogs } from "../../../lib/domains/ui/classes/admin/AdminTUI.js";
import { Display, computeRenderMinGap, jobLabel, jobReportStatus, workItemDisplayStatus } from "../../../lib/domains/ui/classes/display/Display.js";
import { displayColumnWidth, fit as fitDisplay, stripAnsi as stripDisplayAnsi } from "../../../lib/domains/ui/functions/display/helpers/formatters.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(path.dirname(__filename), "../..");
const SCHEMA_PATH = path.resolve(__dirname, "..", "schema.sql");
const ARTIFACT_PROTOCOLS_PATH = path.resolve(__dirname, "..", "config", "artifact-protocols.json");
const TEST_PROMPT_BUNDLE = {
  schema_version: 1,
  prompt_version: "test-bundle",
  roles: {
    researcher: { markdown: "You are the RESEARCHER." },
    planner: { markdown: "You are the PLANNER." },
    dev: { markdown: "You are the DEV AGENT." },
    assessor: { markdown: "You are the ASSESSOR." },
    artificer: { markdown: "You are the ARTIFICER." },
    delegator: { markdown: "You are the DELEGATOR." },
    preflight: { markdown: "You are the PREFLIGHT ROUTER." },
  },
  contracts: {
    "rule-priority": { markdown: "RULE PRIORITY ORDER" },
    "file-scope": { markdown: "FILE SCOPE CONTRACT" },
    "task-modes": { markdown: "TASK MODES" },
    "task-modes-code": { markdown: "TASK MODE (code)" },
    "task-modes-artifact": { markdown: "TASK MODE (artifact)" },
    "file-request": { markdown: "FILE REQUEST PROTOCOL" },
    "dev-log": { markdown: "DEV LOG FORMAT" },
    "artificer-log": { markdown: "ARTIFICER LOG FORMAT" },
    "researcher-output": { markdown: "RESEARCHER OUTPUT CONTRACT" },
    "dev-modes-planner": { markdown: "DEV MODE SELECTION CONTRACT" },
  },
  role_contracts: {
    researcher: ["rule-priority", "researcher-output"],
    dev: ["rule-priority", "file-scope", "task-modes-code", "file-request", "dev-log"],
    artificer: ["rule-priority", "task-modes-artifact", "artificer-log"],
    planner: ["rule-priority", "file-scope", "task-modes", "dev-modes-planner"],
    assessor: ["rule-priority", "file-scope", "task-modes", "file-request"],
    preflight: [],
  },
  skills: [
    {
      id: "frontend-design",
      name: "Frontend Design",
      description: "UI/UX patterns, component composition, responsive layouts.",
      applies_to: ["dev"],
      when_to_use: "Frontend UI changes",
      recycle_session: true,
      body: `Frontend design guidance.\n${"f".repeat(1000)}`,
    },
    {
      id: "bugfix",
      name: "Bugfix",
      description: "Root-cause debugging and minimal fixes.",
      applies_to: ["dev"],
      when_to_use: "Bug fixes and regressions",
      recycle_session: false,
      body: `Bugfix guidance.\n${"b".repeat(1400)}`,
    },
    {
      id: "security",
      name: "Security",
      description: "Secure implementation guidance.",
      applies_to: ["dev"],
      when_to_use: "Security-sensitive changes",
      recycle_session: false,
      body: `Security guidance.\n${"s".repeat(2000)}`,
    },
  ],
};
// Suite filtering:
//   POSSE_TEST_SUITES=all                     -> run everything (default)
//   POSSE_TEST_SUITES=quick                   -> run non-slow suites
//   POSSE_TEST_SUITES=scheduler,atlas,provider  -> run tagged subsets
//   POSSE_TEST_SUITES=re:ATLAS                  -> regex against suite names
// Optional suite mode:
//   POSSE_TEST_SUITE_MODE=fast                -> exclude slow suites/tests
//   POSSE_TEST_SUITE_MODE=slow                -> only slow suites/tests
//   POSSE_TEST_SUITE_MODE=full                -> include fast + slow suites/tests
// Optional skip filter:
//   POSSE_TEST_SKIP_SUITES=slow,re:Admin
function _parseSuiteTokens(raw, fallback = ["all"]) {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  const tokens = value
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : fallback;
}

const _requestedSuiteTokens = _parseSuiteTokens(globalThis.__POSSE_TEST_SUITES ?? process.env.POSSE_TEST_SUITES, ["all"]);
const _skippedSuiteTokens = _parseSuiteTokens(globalThis.__POSSE_TEST_SKIP_SUITES ?? process.env.POSSE_TEST_SKIP_SUITES, []);
const _suiteMode = (() => {
  const raw = String(globalThis.__POSSE_TEST_SUITE_MODE ?? process.env.POSSE_TEST_SUITE_MODE ?? "full").trim().toLowerCase();
  return raw === "fast" || raw === "slow" || raw === "full" ? raw : "full";
})();

const _slowSuiteRegexes = [
  /queue rendering/i,
  /plan to pipeline job creation/i,
  /planner context directories/i,
  /delete no-op handling/i,
  /dirty worktree preservation/i,
  /rebase-on-lease/i,
  /deterministic interruption handling/i,
  /admin image model cycling/i,
  /provider capacity/i,
];

function _suiteTags(name = "") {
  const suiteName = String(name || "");
  const tags = new Set();
  const baseTokens = suiteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const token of baseTokens) tags.add(token);

  if (!/rebase-on-lease/i.test(suiteName) && /lease|deadlock|scheduler|findrunnable/i.test(suiteName)) tags.add("scheduler");
  if (/handoff|file request|workflow handoff/i.test(suiteName)) tags.add("handoff");
  if (/provider|codex|openai|grok/i.test(suiteName)) tags.add("provider");
  if (/atlas/i.test(suiteName)) tags.add("atlas");
  if (/deterministic toolkit|tool runtime|image resize/i.test(suiteName)) tags.add("toolkit");
  if (/queue rendering|admin image model cycling/i.test(suiteName)) tags.add("ui");
  if (/git|worktree|pre-push|dirty|rebase/i.test(suiteName)) tags.add("git");
  if (/artifact/i.test(suiteName)) tags.add("artifact");
  if (/planner|researcher/i.test(suiteName)) tags.add("planning");

  if (_slowSuiteRegexes.some((regex) => regex.test(suiteName))) tags.add("slow");
  return tags;
}

function _matchesToken(token, suiteName, tags) {
  if (token === "all") return true;
  if (token === "quick") return !tags.has("slow");
  if (token === "slow") return tags.has("slow");
  if (token.startsWith("re:")) {
    const pattern = token.slice(3).trim();
    if (!pattern) return false;
    try {
      return new RegExp(pattern, "i").test(suiteName);
    } catch {
      return false;
    }
  }
  if (tags.has(token)) return true;
  return suiteName.toLowerCase().includes(token);
}

const _suiteStack = [];

function _suiteSelection(name) {
  const suiteName = String(name || "");
  const tags = _suiteTags(suiteName);
  const included = _requestedSuiteTokens.some((token) => _matchesToken(token, suiteName, tags));
  if (!included) return { run: false, slowOnlyChildren: false };
  if (_suiteMode === "fast" && tags.has("slow")) return { run: false, slowOnlyChildren: false };
  const skipped = _skippedSuiteTokens.some((token) => _matchesToken(token, suiteName, tags));
  if (skipped) return { run: false, slowOnlyChildren: false };
  if (_suiteMode === "slow" && !tags.has("slow")) return { run: true, slowOnlyChildren: true };
  return { run: true, slowOnlyChildren: false };
}

function _shouldRunSuite(name) {
  return _suiteSelection(name).run;
}

function _slowOnlyChildrenActive() {
  return _suiteStack.some((selection) => selection.slowOnlyChildren);
}

function suite(name, fn) {
  const selection = _suiteSelection(name);
  if (!selection.run) return;
  if (!selection.slowOnlyChildren) {
    describe(name, fn);
    return;
  }
  describe(name, () => {
    _suiteStack.push(selection);
    try {
      fn();
    } finally {
      _suiteStack.pop();
    }
  });
}

function it(name, ...args) {
  if (_slowOnlyChildrenActive()) return;
  return nodeIt(name, ...args);
}

function slowIt(name, ...args) {
  if (_suiteMode === "fast") return;
  return nodeIt(name, ...args);
}

// ─── Test Harness ────────────────────────────────────────────────────────────
// We can't import queue.js directly (it uses getDb() singleton). Instead,
// replicate the core SQL logic against an in-memory DB. This tests the
// schema + queries themselves — the real contracts — not JS wrappers.

let db;
let runtimeModules;
let runtimeDbPath;
let runtimeDbDir;
let runtimeAccountSettingsPath;

function freshDb() {
  const d = new Database(":memory:");
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  d.exec(schema);
  return d;
}

function now() {
  return new Date().toISOString().replace("Z", "").slice(0, 23) + "Z";
}

/** A timestamp guaranteed to be in the future for ready_at comparisons */
function futureTs() {
  return new Date(Date.now() + 5000).toISOString().replace("Z", "").slice(0, 23) + "Z";
}

/** A timestamp guaranteed to be in the past for ready_at defaults */
const PAST_READY = "2020-01-01T00:00:00.000Z";

function createWI(d, title = "Test WI") {
  const stmt = d.prepare(`INSERT INTO work_items (title, description) VALUES (?, ?)`);
  const info = stmt.run(title, "desc");
  return d.prepare(`SELECT * FROM work_items WHERE id = ?`).get(info.lastInsertRowid);
}

function createJob(d, wiId, opts = {}) {
  const {
    job_type = "dev",
    title = "Test job",
    status = "queued",
    parent_job_id = null,
    priority = "normal",
    model_tier = "standard",
    max_attempts = 3,
    payload_json = null,
    ready_at = PAST_READY,
  } = opts;

  const stmt = d.prepare(`
    INSERT INTO jobs (work_item_id, job_type, title, status, parent_job_id, priority, model_tier, max_attempts, payload_json, ready_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(wiId, job_type, title, status, parent_job_id, priority, model_tier, max_attempts, payload_json, ready_at);
  return d.prepare(`SELECT * FROM jobs WHERE id = ?`).get(info.lastInsertRowid);
}

function addDep(d, jobId, depId, kind = "hard") {
  d.prepare(`INSERT OR IGNORE INTO job_dependencies (job_id, depends_on_job_id, dependency_kind) VALUES (?, ?, ?)`)
    .run(jobId, depId, kind);
}

function setStatus(d, jobId, status) {
  d.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), jobId);
}

function resetRuntimeDb() {
  __resetAtlasRuntimeDisabledForTests();
  // Drop any events queued for the soon-to-be-closed DB. Without this,
  // pending inserts would flush against the fresh DB on the next call
  // and create rows with stale work_item_id / job_id references.
  runtimeModules.queueMod._discardPendingEventsForTests?.();
  // The provider-usage cache is a process singleton, untouched by closing the
  // DB. Clear it so a prior test's usage snapshot (or an async refresh that
  // resolves late, against the just-replaced DB) can't bleed into the next
  // test's rendered budget gauges.
  providerUsageRuntimeCache.reset();
  runtimeModules.dbMod.closeDb();
  // Re-assert the canonical runtime-DB override BEFORE reopening. In the shared
  // aggregate process, in-thread worker bootstraps (context-worker /
  // EmbeddingIndexChildWorker, exercised by the ATLAS live-rebuffer edit path)
  // run `setRuntimePathOverrides(workerData?.runtimePathOverrides || null)` —
  // with no overrides that resets them to `{}`, so getRuntimeDbPath() falls back
  // to `<cwd>/.posse/db/orchestrator.db`: the REAL repo DB. Without re-asserting,
  // every later getDb() reopens that repo DB (its rows leak into tests, and tests
  // can mutate the developer's actual DB). Pinning dbPath back to the temp path
  // makes the reset point at the canonical sandbox no matter who cleared it.
  setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
  // Remove the WAL/SHM/journal sidecars too — not just the main .db file, so a
  // leftover `-wal` can't be replayed into the reopened DB.
  _removeDbWithSidecars(runtimeDbPath);
  runtimeModules.dbMod.getDb();
  // Reset the global account-settings DB too. In the aggregate run all suites
  // share one process, so global settings (provider tiers/roles, model choices,
  // atlas_*) written by one suite would otherwise leak forward and mask
  // defaults in the next — symmetric with the runtime DB reset above.
  if (runtimeAccountSettingsPath) {
    closeAccountSettingsDb();
    _removeDbWithSidecars(runtimeAccountSettingsPath);
    setAccountSettingsPathForTests(runtimeAccountSettingsPath);
  }
  // Drop the in-memory remote model catalog. Its lazy background load can
  // race the sandbox path swap above and cache the developer's REAL
  // ~/.posse/account.db catalog (e.g. claude:sonnet pricing resolving as
  // "remote:" instead of "default:"). Invalidating here forces the next read
  // to go through the sandboxed account-settings DB, which is empty.
  invalidateRemoteModelCatalog();
}

/**
 * Delete a SQLite database file along with every sidecar SQLite may leave
 * behind (WAL/SHM/journal). Removing only the main `.db` leaves a non-empty
 * `-wal`/`-shm` that the next connection replays, leaking committed rows
 * across suites in the shared aggregate process.
 */
function _removeDbWithSidecars(dbPath) {
  if (!dbPath) return;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* ignore */ }
  }
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
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

function withAccountSettingsPath(settingsPath, fn) {
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(settingsPath || runtimeAccountSettingsPath);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        closeAccountSettingsDb();
        setAccountSettingsPathForTests(runtimeAccountSettingsPath);
      });
    }
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(runtimeAccountSettingsPath);
    return result;
  } catch (err) {
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(runtimeAccountSettingsPath);
    throw err;
  }
}

function writeAccountSettingsDb(settingsPath, updates = {}) {
  return withAccountSettingsPath(settingsPath, () => setAccountSettings(updates));
}

function withClaudeConfigDir(configDir, fn) {
  setClaudeConfigDirForTests(configDir);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => setClaudeConfigDirForTests(null));
    }
    setClaudeConfigDirForTests(null);
    return result;
  } catch (err) {
    setClaudeConfigDirForTests(null);
    throw err;
  }
}

function withQueueSettings(updates, fn) {
  const queueMod = runtimeModules.queueMod;
  const previous = {};
  for (const key of Object.keys(updates || {})) previous[key] = queueMod.getSetting(key);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) queueMod.setSetting(key, value);
  };
  try {
    for (const [key, value] of Object.entries(updates || {})) queueMod.setSetting(key, value);
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function dispatchWorker(worker, job, tier = "standard", attemptId = null, attemptCount = 1) {
  return worker._dispatch(job, tier, attemptCount, attemptId);
}

function stubWorkerRole(worker, jobType, run) {
  const existing = worker.roleRegistry.get(jobType);
  worker.roleRegistry.roles.set(jobType, {
    getRole: () => existing?.getRole?.() || jobType,
    canSpawn: (...args) => existing?.canSpawn?.(...args) || false,
    run,
  });
}

function makeWorker(workerMod, opts = {}, providerCall = null) {
  const workerOpts = { ...opts };
  if (providerCall) workerOpts.providerClient = { call: providerCall };
  return new workerMod.Worker(workerOpts);
}

function withArtifactProtocols(mutator, fn) {
  const original = fs.readFileSync(ARTIFACT_PROTOCOLS_PATH, "utf-8");
  const config = JSON.parse(original);
  mutator(config);
  fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  reloadArtifactProtocols();
  const restore = () => {
    fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, original, "utf-8");
    reloadArtifactProtocols();
  };
  let restoreInFinally = true;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      restoreInFinally = false;
      return result.finally(restore);
    }
    return result;
  } finally {
    if (restoreInFinally) restore();
  }
}

before(async () => {
  setActivePromptBundleForTest(TEST_PROMPT_BUNDLE);
  runtimeDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-db-"));
  runtimeDbPath = path.join(runtimeDbDir, "orchestrator.db");
  runtimeAccountSettingsPath = path.join(runtimeDbDir, "account-settings.db");
  setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
  setAccountSettingsPathForTests(runtimeAccountSettingsPath);
  // Sandbox the daemon process ledger: scheduler-boot suites call the orphan
  // reaper, which must never scan/kill against the developer's real
  // ~/.posse/daemons. Keep it under the per-run temp dir.
  setDaemonLedgerDirForTests(path.join(runtimeDbDir, "daemons"));

  const dbMod = await import("../../../lib/shared/storage/functions/index.js");
  const queueMod = await import("../../../lib/domains/queue/functions/index.js");
  const assessorMod = await import("../../../lib/domains/worker/classes/roles/assessor.js");
  const schedulerMod = await import("../../../lib/domains/scheduler/classes/Scheduler.js");
  const workerMod = await import("../../../lib/domains/worker/classes/Worker.js");
  const observationsMod = await import("../../../lib/domains/observability/functions/observations.js");
  const projectContextMod = await import("../../../lib/domains/project/functions/context.js");
  const hooksMod = await import("../../../lib/domains/worker/functions/helpers/hooks.js");
  const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");

  runtimeModules = { dbMod, queueMod, assessorMod, schedulerMod, workerMod, observationsMod, projectContextMod, hooksMod, handoffMod };
  resetRuntimeDb();
});

afterEach(() => {
  __resetAtlasRuntimeDisabledForTests();
});

after(() => {
  __resetAtlasRuntimeDisabledForTests();
  if (runtimeModules?.dbMod) runtimeModules.dbMod.closeDb();
  closeAccountSettingsDb();
  try { fs.rmSync(runtimeDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  setRuntimePathOverridesForTests(null);
  setAccountSettingsPathForTests(null);
  setDaemonLedgerDirForTests(null);
});

export {
  describe,
  it,
  slowIt,
  before,
  beforeEach,
  after,
  afterEach,
  assert,
  Database,
  fs,
  http,
  os,
  path,
  EventEmitter,
  execFileSync,
  spawnSync,
  fileURLToPath,
  __filename,
  __dirname,
  SCHEMA_PATH,
  ARTIFACT_PROTOCOLS_PATH,
  _parseSuiteTokens,
  _suiteTags,
  _matchesToken,
  _shouldRunSuite,
  suite,
  runtimeModules,
  runtimeDbPath,
  runtimeDbDir,
  runtimeAccountSettingsPath,
  freshDb,
  now,
  futureTs,
  PAST_READY,
  createWI,
  createJob,
  addDep,
  setStatus,
  resetRuntimeDb,
  withEnv,
  withAccountSettingsPath,
  writeAccountSettingsDb,
  withClaudeConfigDir,
  withQueueSettings,
  dispatchWorker,
  stubWorkerRole,
  makeWorker,
  withArtifactProtocols,
  closeAccountSettingsDb,
  setAccountSettings,
  setAccountSettingsPathForTests,
  setRuntimePathOverridesForTests,
  __testResetProviderUsageAuthPrime,
  getAvailableProviders,
  getConfiguredProviderUsage,
  getProvider,
  getProviderBackoff,
  getProviderCapacityState,
  getProviderHealth,
  getProviderMap,
  getProviderName,
  getProviderRateLimitState,
  getProviderAtlasMap,
  getProviderAtlasSupport,
  getProviderTierInfo,
  getProviderUsage,
  getProviderUsageAsync,
  inferProviderWindowLimit,
  isMultiProvider,
  isProviderReady,
  isProviderSelectable,
  needsDelegation,
  primeProviderUsageAuth,
  primeProviderUsageAuthAsync,
  providerSupportsAtlas,
  selectProviderName,
  tierModelName,
  applyAtlasBootEnv,
  buildAtlasCapability,
  buildAtlasBootEnv,
  buildAtlasIntegrationPlan,
  buildAtlasMcpServerConfig,
  buildAtlasServerSpec,
  buildAtlasIndexInvocation,
  buildWorkItemAtlasConfig,
  ensureAtlasCommitReindexHook,
  ensureAtlasRepoIndexedOnBoot,
  ensureWorkItemAtlasJoin,
  reindexAtlasAfterCommit,
  getAtlasIntegrationConfig,
  getAtlasRouteForRole,
  resolveAtlasRepoTarget,
  resolveAtlasGraphDbPath,
  resolveWorkItemAtlasGraphDbPath,
  resolveAtlasExecutionAttachment,
  seedWorkItemAtlasGraphFromPrimary,
  shouldUseAtlasInLiveFunnel,
  summarizeAtlasIntegrationPlan,
  isAtlasGraphCorruptionError,
  attemptAtlasGraphRecovery,
  buildAtlasSmokeConfig,
  readConfiguredAtlasRepos,
  runAtlasSmokeTest,
  disableAtlasForRun,
  getAtlasRuntimeDisabledReason,
  isAtlasRuntimeDisabled,
  ensureProjectMap,
  ensureProjectMapRebuildHook,
  generateProjectMap,
  getCachedProjectMap,
  buildGateLockedToolError,
  checkNativeToolAllowed,
  configureGate,
  getFallbackStrikeLimit,
  getMeaningfulAtlasCalls,
  getRequiredMeaningfulAtlasCalls,
  getUnhelpfulStrikes,
  getUnlockReason,
  isFallbackAtlasPrefetchStatus,
  isRelevantAtlasPrefetchStatus,
  isGateActive,
  isFileDiscoveredForGate,
  isGatedTool,
  isGateUnlocked,
  noteAtlasCall,
  unlockForAtlasPrefetch,
  unlockForAtlasUnavailable,
  __resetGateForTests,
  buildFoldedAtlasToolDescriptor,
  buildNativeToolDescriptor,
  isBlockedFoldedAtlasTool,
  jobNeedsGitWorktree,
  jobsNeedGitWorktree,
  normalizeIntakeHints,
  buildIntakeHintsBlock,
  buildResearchIntakePreload,
  getResearchBudget,
  isDeepthinkTask,
  researchBudgetToReasoningEffort,
  collectHandledSuggestionKeys,
  createApprovedSuggestionFollowUp,
  suggestionDecisionEventJson,
  suggestionDevJobDecision,
  suggestionReviewKey,
  sanitizeHumanQuestions,
  isRepoFileAccessQuestion,
  inferPromoteTask,
  normalizePromoteMappings,
  isUnderRoot,
  normPath,
  normalizeRoots,
  gitCommitAll,
  buildCleanupInventory,
  cleanupInventoryIsEmpty,
  cleanupInventorySummary,
  buildCleanupItemIndex,
  cleanupDeterministicFallback,
  applyCleanupAction,
  discardCleanupSnapshot,
  discardCleanupWorktree,
  escalateTier,
  extractJson,
  parseErrorBackoff,
  setClaudeConfigDirForTests,
  warmOauthSession,
  handoff,
  parseMissingContext,
  parseFileRequest,
  classifyFileRisk,
  splitFileRequestsByRisk,
  parseResearcherStructuredOutput,
  extractResearcherFiles,
  normalizeResearcherFilePriorities,
  researcherOutputNeedsHuman,
  _parseFunctions,
  _buildSmartPreload,
  renderAtlasHandoffSections,
  clearSkillRegistryCache,
  getEnabledSkillsForRole,
  loadSkillManifests,
  validateSkillIds,
  reloadArtifactProtocols,
  getArtifactProtocol,
  getResolvedImageProtocol,
  validateManifestAgainstContract,
  injectArtifactScope,
  normalizeArtifactCreateFiles,
  buildManifest,
  cleanupArtifactDirs,
  pruneEmptyArtifactDirs,
  artifactsDir,
  inputsDir,
  workspaceDir,
  contextDir,
  wiScopeId,
  workItemArtifactRoot,
  artifactTaskOutputRoot,
  AdminTUI,
  canUseAdminTui,
  purgeRuntimeLogs,
  Display,
  computeRenderMinGap,
  jobLabel,
  jobReportStatus,
  workItemDisplayStatus,
  displayColumnWidth,
  fitDisplay,
  stripDisplayAnsi,
};
