// @ts-check
//
// ATLAS v2-native integration facade.
//
// This is the single ATLAS integration surface. ATLAS tools go through the
// in-process v2 ledger/view backend.

import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { getDb } from "../../../shared/storage/functions/index.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { isExternallyRoutedAtlasTool } from "./deterministic-mcp/tool-descriptors.js";
import { POSSE_MCP_GATEWAY_TRANSPORT } from "./mcp-gateway.js";
import { Ledger } from "../../atlas/classes/v2/Ledger.js";
import { View as AtlasView } from "../../atlas/classes/v2/View.js";
import { Warmer } from "../../atlas/classes/v2/Warmer.js";
import { resolveTargetBranch, resolveTargetBranchAsync } from "../../git/functions/target-branch.js";
import { gitCurrentHashAsync } from "../../git/functions/utils.js";
import { ledgerBranchForWi } from "../../atlas/functions/v2/runtime-paths.js";
import { describeScipStagingState, ensureScipStaged } from "../../atlas/functions/v2/scip/stager.js";
import { listScipFiles } from "../../atlas/functions/v2/scip/ingester.js";
import { openViewWithMeta, viewFreshness } from "../../atlas/functions/v2/view-health.js";
import { runSqliteWrite } from "../../../shared/concurrency/functions/sqlite-gate.js";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { sanitizeWorkerExecArgv } from "../../runtime/functions/worker-exec-argv.js";
import { getAtlasV2BootTimeoutMs } from "../../settings/functions/tunables.js";
import { recordEmbeddingForensics, errorForTelemetry } from "../../atlas/functions/v2/embeddings/forensics.js";
import { embeddingsExplicitlyEnabled, configuredVectorBackend } from "../../atlas/functions/v2/embeddings/resources.js";
import {
  warmReadinessProgress,
  warmReadinessSeed,
  warmReadinessStarted,
} from "../../atlas/functions/v2/warm-progress.js";
import {
  formatAtlasError,
  isVerboseAtlasErrors,
  logAtlasError,
} from "../../atlas/functions/v2/verbose-errors.js";
import {
  isAuthoritativeAtlasV2Mode,
  normalizeAtlasScipMode,
  shouldRunScipPhase,
  shouldUseAtlasV2,
} from "./atlas-v2-mode.js";
import {
  ATLAS_ROLE_ORDER,
  applyAtlasBootEnv,
  buildAtlasBootEnv,
  __resetAtlasRuntimeDisabledForTests,
  disableAtlasForRun,
  getAtlasIntegrationConfig,
  getAtlasProviderSupport as getConfiguredAtlasProviderSupport,
  getAtlasRouteForRole,
  getAtlasRuntimeDisabledReason,
  invalidateAtlasIntegrationConfigCache,
  isAtlasRuntimeDisabled,
  loadAdaptiveSplitTarget,
  normalizeAtlasRuntimeDisableRepoKey,
  resolveAtlasAssignmentUnit,
  resolveSplitAssignment,
  withAtlasConfigOverrides,
} from "./atlas/config.js";
import {
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  isAtlasV2EmissionEnabled as isAtlasV2PipelineEmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import {
  resolveAtlasRepoTarget,
  resolveAtlasRepoTargetAsync,
} from "./atlas/repo.js";

export {
  ATLAS_ROLE_ORDER,
  applyAtlasBootEnv,
  buildAtlasBootEnv,
  __resetAtlasRuntimeDisabledForTests,
  disableAtlasForRun,
  getAtlasIntegrationConfig,
  getAtlasRouteForRole,
  getAtlasRuntimeDisabledReason,
  invalidateAtlasIntegrationConfigCache,
  isAtlasRuntimeDisabled,
  normalizeAtlasRuntimeDisableRepoKey,
  resolveAtlasAssignmentUnit,
  resolveAtlasRepoTarget,
  resolveAtlasRepoTargetAsync,
  withAtlasConfigOverrides,
};
export { runAtlasTreeCompressionModelPass } from "./atlas/tree-compression.js";
export { computeAtlasLayerReadiness, summarizeAtlasReadiness } from "../../atlas/functions/v2/readiness.js";
export { enqueueAtlasSelfRepair } from "../../atlas/functions/v2/self-repair.js";
import { enqueueAtlasSelfRepair as enqueueAtlasSelfRepairSync } from "../../atlas/functions/v2/self-repair.js";

const ATLAS_V2_BOOT_WORKER_URL = new URL("./atlas-v2-boot-worker.js", import.meta.url);
// Boot-time main-view freshness checks run in a worker thread so their
// synchronous repo-walk / better-sqlite3 work never blocks the CLI event loop
// (which would starve the scheduler's lock-renew heartbeat). SCIP staging is no
// longer kicked from here — the boot warm worker stages it inline, concurrently
// with the tree-sitter parse (see ParseEngine.handleWarmJob).
const VIEW_INSPECT_WORKER_URL = new URL("../../atlas/functions/v2/view-inspect-worker.js", import.meta.url);
const ATLAS_BOOT_THREAD_MANAGER = new ThreadManager();
const ATLAS_MAIN_WARM_PURPOSES = new Set(["main-incremental", "main-full", "main-merge", "scip-restage"]);
const ATLAS_V2_BOOT_WORKER_STOP_GRACE_MS = 10_000;

/**
 * Run the boot main-view freshness check in a worker thread.
 * @param {any} [args]
 * @returns {Promise<{ exists: boolean, readable: boolean, branchMatches: boolean, current: boolean, error: string | null }>}
 */
function inspectMainViewForBootInWorker({ viewPath, branch, ledgerDbPath = null, timeoutMs = 120_000, signal = null } = {}) {
  return ATLAS_BOOT_THREAD_MANAGER.run(VIEW_INSPECT_WORKER_URL, {
    label: "ATLAS boot view inspect",
    timeoutMs,
    signal,
    workerData: { viewPath, branch, ledgerDbPath },
  });
}

const ATLAS_READINESS_WORKER_URL = new URL("../../atlas/functions/v2/readiness-worker.js", import.meta.url);

/**
 * Worker-backed enqueueAtlasSelfRepair: the readiness inspection (synchronous
 * better-sqlite3 COUNT(*) scans over view symbols and per-model vectors) runs
 * in a worker thread so a mid-run repair — e.g. backgrounded boot work failing
 * after the TUI attached — never blocks the CLI event loop or starves the
 * scheduler's lock-renew heartbeat. The repair-warm enqueues themselves stay
 * on the main thread (cheap, coalescing outbox writes). Falls back to the
 * inline inspection if the worker fails — self-repair must stay best-effort.
 *
 * @param {{
 *   repoRoot: string,
 *   config?: Record<string, any>,
 *   reason?: string,
 *   targetBranch?: string,
 *   onError?: (err: Error) => void,
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<ReturnType<typeof enqueueAtlasSelfRepairSync>>}
 */
export async function enqueueAtlasSelfRepairInWorker({
  repoRoot,
  config = {},
  reason = "unspecified",
  targetBranch = "main",
  onError = undefined,
  timeoutMs = 120_000,
} = {}) {
  if (config?.enabled === false) {
    return { ok: false, skipped: "atlas_disabled", summary: "atlas disabled", layers: [], actions: [] };
  }
  let readiness = null;
  try {
    readiness = await ATLAS_BOOT_THREAD_MANAGER.run(ATLAS_READINESS_WORKER_URL, {
      label: "ATLAS readiness inspect",
      timeoutMs,
      workerData: { repoRoot, config },
    });
  } catch {
    readiness = null; // worker unavailable — fall back to the inline scan
  }
  return enqueueAtlasSelfRepairSync({ repoRoot, config, reason, targetBranch, onError, readiness });
}
const ATLAS_POST_COMMIT_HOOK_BEGIN = "# >>> POSSE ATLAS REINDEX (managed) >>>";
const ATLAS_POST_COMMIT_HOOK_END = "# <<< POSSE ATLAS REINDEX (managed) <<<";
const LEGACY_SDL_POST_COMMIT_HOOK_BEGIN = "# >>> POSSE SDL REINDEX (managed) >>>";
const LEGACY_SDL_POST_COMMIT_HOOK_END = "# <<< POSSE SDL REINDEX (managed) <<<";

function cloneArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function shQuote(value) {
  return `'${toPosixPath(value).replace(/'/g, "'\"'\"'")}'`;
}

function stripManagedHookBlock(content = "", beginMarker = "", endMarker = "") {
  const begin = String(content || "").indexOf(beginMarker);
  if (begin === -1) return String(content || "");
  const end = String(content || "").indexOf(endMarker, begin);
  if (end === -1) return String(content || "").slice(0, begin).trimEnd();
  const before = String(content || "").slice(0, begin).trimEnd();
  const after = String(content || "").slice(end + endMarker.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n");
}

function resolveAtlasGitHooksDir(cwd = null, execImpl = spawnSync) {
  const repoCwd = path.resolve(cwd || process.cwd());
  const gitPath = path.join(repoCwd, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return path.join(gitPath, "hooks");
  } catch {
    // Fall through to git, which handles linked worktrees.
  }

  try {
    const out = /** @type {any} */ (execImpl("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: repoCwd,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }) || {});
    if (Number.isInteger(out.status) && out.status !== 0) return null;
    const raw = String(out.stdout || "").trim();
    return raw ? path.resolve(repoCwd, raw) : null;
  } catch {
    return null;
  }
}

function buildAtlasPostCommitHookBlock(repoCwd) {
  const modulePath = fileURLToPath(new URL("./atlas-post-commit.js", import.meta.url));
  const logPath = path.join(repoCwd, ".posse", "logs", "atlas-post-commit.log");
  return [
    ATLAS_POST_COMMIT_HOOK_BEGIN,
    "# Auto-generated by Posse. Emits ATLAS v2 warm events after merge commits.",
    `POSSE_ATLAS_LOG=${shQuote(logPath)}`,
    `mkdir -p "$(dirname "$POSSE_ATLAS_LOG")" 2>/dev/null || true`,
    `if [ -f "$POSSE_ATLAS_LOG" ]; then`,
    `  SZ=$(wc -c < "$POSSE_ATLAS_LOG" 2>/dev/null || echo 0)`,
    `  [ "\${SZ:-0}" -gt 1048576 ] && mv -f "$POSSE_ATLAS_LOG" "$POSSE_ATLAS_LOG.1"`,
    `fi`,
    `POSSE_ATLAS_HOOK_TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)`,
    `if [ "$POSSE_ATLAS_HOOK_TOP" = ${shQuote(repoCwd)} ]; then`,
    `  (`,
    `    cd ${shQuote(repoCwd)} || exit 0`,
    `    NODE_BIN="\${POSSE_NODE:-node}"`,
    `    if command -v "$NODE_BIN" >/dev/null 2>&1; then POSSE_ATLAS_NODE_BIN="$NODE_BIN"; else POSSE_ATLAS_NODE_BIN=${shQuote(process.execPath)}; fi`,
    `    {`,
    `      echo "--- $(date -u +%FT%TZ) commit=$(git rev-parse --short HEAD 2>/dev/null) ---"`,
    `      "$POSSE_ATLAS_NODE_BIN" ${shQuote(modulePath)} ${shQuote(repoCwd)} --merge-only`,
    `      echo "[exit=$?]"`,
    `    } >> "$POSSE_ATLAS_LOG" 2>&1`,
    `  ) || true`,
    `else`,
    `  echo "--- $(date -u +%FT%TZ) skipped linked worktree=$POSSE_ATLAS_HOOK_TOP ---" >> "$POSSE_ATLAS_LOG" 2>&1 || true`,
    `fi`,
    ATLAS_POST_COMMIT_HOOK_END,
  ].join("\n");
}

function normalizeProvider(providerName = "claude") {
  return String(providerName || "claude").trim().toLowerCase() || "claude";
}

function normalizeRole(role = "unknown") {
  return String(role || "unknown").trim().toLowerCase() || "unknown";
}

function resolveFallbackMode(config = {}) {
  return (config.normalizedMode || config.mode) === "required" ? "fail" : "preload";
}

function resolveNonNegativeMs(value, fallback) {
  if (value != null) {
    const explicit = Number(value);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  return fallback;
}

function resolveAtlasV2BootTimeoutMs(value = null, config = null) {
  if (value != null && String(value).trim() !== "") {
    const explicit = Number(value);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  if (config?.bootTimeoutMs != null && String(config.bootTimeoutMs).trim() !== "") {
    const configured = Number(config.bootTimeoutMs);
    if (Number.isFinite(configured) && configured >= 0) return configured;
  }
  return getAtlasV2BootTimeoutMs();
}

function normalizeAtlasBootReindexPolicy(value = null) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "always" || raw === "missing" || raw === "smart" ? raw : "smart";
}

function uniqueSourceLanguages(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const lang = String(raw || "").trim().toLowerCase();
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);
    out.push(lang);
  }
  return out;
}

function isAtlasIndexMaintenanceEnabled(config = {}) {
  return !!(config?.enabled && Array.isArray(config.phases) && config.phases.length > 0);
}

function repoStorageFor({ cwd = null, config = getAtlasIntegrationConfig() } = {}) {
  const repo = resolveAtlasRepoTarget({ cwd, config });
  const repoRoot = repo.repoPath || cwd || process.cwd();
  const atlasRoot = path.join(repoRoot, ".posse", "atlas");
  return {
    repo,
    repoRoot,
    atlasRoot,
    ledgerDbPath: path.join(atlasRoot, "ledger.db"),
    mainViewDbPath: path.join(atlasRoot, "views", "main.view.db"),
    warmedRoot: path.join(atlasRoot, "views", "warmed"),
  };
}

function atlasWarmRuntimeExists(storage = {}) {
  try {
    return !!(
      storage?.ledgerDbPath && fs.existsSync(storage.ledgerDbPath)
    ) || !!(
      storage?.repoRoot && fs.existsSync(path.join(storage.repoRoot, ".posse"))
    );
  } catch {
    return false;
  }
}

async function repoStorageForAsync({ cwd = null, config = getAtlasIntegrationConfig(), signal = null } = {}) {
  const repo = await resolveAtlasRepoTargetAsync({ cwd, config, signal });
  const repoRoot = repo.repoPath || cwd || process.cwd();
  const atlasRoot = path.join(repoRoot, ".posse", "atlas");
  return {
    repo,
    repoRoot,
    atlasRoot,
    ledgerDbPath: path.join(atlasRoot, "ledger.db"),
    mainViewDbPath: path.join(atlasRoot, "views", "main.view.db"),
    warmedRoot: path.join(atlasRoot, "views", "warmed"),
  };
}

function resolveAtlasBaselineBranch(repoRoot = null) {
  try {
    return resolveTargetBranch(repoRoot || process.cwd());
  } catch {
    return "main";
  }
}

// Async twin for in-session call sites (freshness gate, warm jobs, runtime
// mounts): branch resolution is a native git call (~50–95ms), and the sync
// form blocks the orchestrator event loop — a visible TUI hiccup every time
// the warm route fires.
async function resolveAtlasBaselineBranchAsync(repoRoot = null) {
  try {
    return await resolveTargetBranchAsync(repoRoot || process.cwd());
  } catch {
    return "main";
  }
}

function parseAtlasWarmPayload(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function atlasWarmPayloadTargetBranch(payload = {}, fallbackBranch = "main") {
  const purpose = String(payload?.purpose || "wi").trim();
  if (purpose === "main-merge") {
    return String(payload?.onto_branch || payload?.target_branch || fallbackBranch || "main").trim() || "main";
  }
  return String(payload?.target_branch || payload?.branch || payload?.onto_branch || fallbackBranch || "main").trim() || "main";
}

function atlasWarmPayloadIsMainRefresh(payload = {}, targetBranch = "main") {
  const purpose = String(payload?.purpose || "").trim();
  if (!ATLAS_MAIN_WARM_PURPOSES.has(purpose)) return false;
  return atlasWarmPayloadTargetBranch(payload, targetBranch) === String(targetBranch || "main");
}

async function currentGitHeadAsync(cwd = process.cwd()) {
  try {
    return String(await gitCurrentHashAsync(cwd, { timeoutMs: 5000 }) || "").trim();
  } catch {
    return "";
  }
}

export async function listPendingAtlasMainWarmJobs({ cwd = null, config = getAtlasIntegrationConfig(), targetBranch = null } = {}) {
  if (!config?.enabled || !isAtlasIndexMaintenanceEnabled(config)) return [];
  const storage = repoStorageFor({ cwd, config });
  const branch = String(targetBranch || await resolveAtlasBaselineBranchAsync(storage.repoRoot) || "main").trim() || "main";
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, work_item_id, status, priority, payload_json, ready_at, lease_owner, lease_expires_at, updated_at
    FROM jobs
    WHERE job_type = 'atlas_warm'
      AND status IN ('queued', 'leased', 'running')
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'leased' THEN 1 ELSE 2 END,
      id ASC
    LIMIT 500
  `).all();
  return rows
    .map((row) => {
      const payload = parseAtlasWarmPayload(row.payload_json);
      return {
        ...row,
        payload,
        purpose: String(payload?.purpose || ""),
        targetBranch: atlasWarmPayloadTargetBranch(payload, branch),
      };
    })
    .filter((row) => atlasWarmPayloadIsMainRefresh(row.payload, branch));
}

export async function requestAtlasMainRefreshForFreshnessGate({
  cwd = null,
  config = getAtlasIntegrationConfig(),
  targetBranch = null,
  reason = "freshness_gate",
} = {}) {
  if (!config?.enabled || !isAtlasIndexMaintenanceEnabled(config)) {
    return { ok: false, attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" };
  }
  if (!isAtlasV2PipelineEmissionEnabled(config)) {
    return { ok: false, attempted: false, skipped: "atlas_v2_emission_disabled", backend: "atlas-v2" };
  }
  const storage = repoStorageFor({ cwd, config });
  const branch = String(targetBranch || await resolveAtlasBaselineBranchAsync(storage.repoRoot) || "main").trim() || "main";
  const head = await currentGitHeadAsync(storage.repoRoot);
  const result = emitAtlasV2MainAdvanced({
    payload: {
      from_sha: "",
      to_sha: head,
      target_branch: branch,
      paths: [],
      source: "freshness_gate",
      reason,
    },
    onError: () => {},
  });
  return {
    ...result,
    attempted: true,
    backend: "atlas-v2",
    targetBranch: branch,
    head,
  };
}

export async function checkAtlasMainFreshnessGate({
  cwd = null,
  config = getAtlasIntegrationConfig(),
  targetBranch = null,
  requestRefresh = true,
} = {}) {
  if (!shouldUseAtlasV2({ config }) || !config?.enabled) {
    return { ready: true, attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" };
  }
  if (!isAtlasIndexMaintenanceEnabled(config)) {
    return { ready: true, attempted: false, skipped: "phase_not_enabled", backend: "atlas-v2" };
  }

  const storage = repoStorageFor({ cwd, config });
  const branch = String(targetBranch || await resolveAtlasBaselineBranchAsync(storage.repoRoot) || "main").trim() || "main";
  const runtimeExists = atlasWarmRuntimeExists(storage);
  const pending = await listPendingAtlasMainWarmJobs({ cwd: storage.repoRoot, config, targetBranch: branch });
  if (!runtimeExists) {
    const readiness = probeAtlasGraphReadiness({ cwd: storage.repoRoot, config });
    return {
      ready: false,
      attempted: true,
      action: "degrade",
      reason: "atlas_warm_runtime_missing",
      backend: "atlas-v2",
      targetBranch: branch,
      readiness,
      pendingWarmJobs: pending,
    };
  }
  if (pending.length > 0) {
    return {
      ready: false,
      attempted: true,
      action: "defer",
      reason: "atlas_refresh_pending",
      backend: "atlas-v2",
      targetBranch: branch,
      pendingWarmJobs: pending,
    };
  }

  const readiness = probeAtlasGraphReadiness({ cwd: storage.repoRoot, config });
  if (readiness.usable) {
    return {
      ready: true,
      attempted: true,
      reason: "atlas_current",
      backend: "atlas-v2",
      targetBranch: branch,
      readiness,
      pendingWarmJobs: [],
    };
  }

  if (requestRefresh && config.autoRefreshStale !== false) {
    const requested = await requestAtlasMainRefreshForFreshnessGate({
      cwd: storage.repoRoot,
      config,
      targetBranch: branch,
      reason: readiness.reason || "atlas_view_not_ready",
    });
    const refreshedPending = await listPendingAtlasMainWarmJobs({ cwd: storage.repoRoot, config, targetBranch: branch });
    if (requested.ok || refreshedPending.length > 0) {
      return {
        ready: false,
        attempted: true,
        action: "defer",
        reason: "atlas_refresh_requested",
        backend: "atlas-v2",
        targetBranch: branch,
        readiness,
        request: requested,
        pendingWarmJobs: refreshedPending,
      };
    }
  }

  return {
    ready: false,
    attempted: true,
    action: "degrade",
    reason: readiness.reason || "atlas_not_ready",
    backend: "atlas-v2",
    targetBranch: branch,
    readiness,
    pendingWarmJobs: [],
  };
}

function inspectMainViewForBoot(viewPath, branch, ledgerDbPath = null) {
  const status = {
    exists: false,
    readable: false,
    branchMatches: false,
    current: false,
    meta: null,
    freshness: null,
    error: null,
  };
  const probe = openViewWithMeta(viewPath, AtlasView);
  try {
    status.exists = !!probe.exists;
    if (!probe.ok) {
      status.error = probe.error?.message || String(probe.error || "view_unreadable");
      return status;
    }
    status.readable = true;
    status.meta = probe.meta || null;
    status.branchMatches = probe.meta?.branch === branch;
    if (!status.branchMatches) return status;
    if (!ledgerDbPath) {
      status.current = true;
      return status;
    }
    let ledger = null;
    try {
      ledger = Ledger.openReadOnly({ dbPath: ledgerDbPath });
      status.freshness = viewFreshness(probe.meta, ledger);
      status.current = status.freshness.current === true;
    } catch (err) {
      status.error = err?.message || String(err);
      status.current = false;
    } finally {
      try { ledger?.close?.(); } catch { /* ignore */ }
    }
    return status;
  } finally {
    try { if (probe.ok) probe.view.close(); } catch { /* ignore */ }
  }
}

function mainViewMatchesBranch(viewPath, branch) {
  return inspectMainViewForBoot(viewPath, branch).branchMatches;
}

function workItemViewPath(worktreePath = null) {
  const root = worktreePath || process.cwd();
  return path.join(root, ".posse", "atlas", "view.db");
}

function warmedWorkItemViewPath(projectDir = null, workItemId = null) {
  const { warmedRoot } = repoStorageFor({ cwd: projectDir });
  const token = String(workItemId ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return token ? path.join(warmedRoot, `wi-${token}.view.db`) : null;
}

function ensureParentDir(filePath = null) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function asyncBoundary() {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function emitBootProgress(onProgress, event = {}) {
  if (typeof onProgress !== "function") return;
  try { onProgress({ backend: "atlas-v2", ...event }); } catch { /* progress callbacks are observational */ }
}

function tailText(value, max = 4000) {
  const text = String(value || "");
  return text.length > max ? text.slice(text.length - max) : text;
}

function errorFromWorkerPayload(payload = {}) {
  const err = new Error(payload?.message || "ATLAS v2 boot worker failed");
  err.name = payload?.name || "Error";
  if (payload?.stack) err.stack = payload.stack;
  if (payload?.code) {
    try { /** @type {any} */ (err).code = payload.code; } catch { /* ignore */ }
  }
  return err;
}

function decorateWorkerError(err, extra = {}) {
  for (const [key, value] of Object.entries(extra)) {
    try { err[key] = value; } catch { /* ignore */ }
  }
  return err;
}

function runAtlasV2BootWarmWorkerThread({
  ledgerDbPath,
  repoRoot,
  defaultBranch,
  mainViewDbPath,
  config = {},
  onProgress = null,
  timeoutMs = null,
  testBlockMs = 0,
  purpose = "main-full",
}) {
  const maxMs = resolveAtlasV2BootTimeoutMs(timeoutMs, config);
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const worker = new NodeWorker(ATLAS_V2_BOOT_WORKER_URL, {
      execArgv: sanitizeWorkerExecArgv(),
      stderr: true,
      workerData: {
        ledgerDbPath,
        repoRoot,
        defaultBranch,
        mainViewDbPath,
        config,
        testBlockMs,
        purpose,
        nativeAuth: heartbeatAuthManager.getCapability(),
      },
    });
    recordEmbeddingForensics("atlas.boot_worker_thread.start", {
      ledger_db_path: ledgerDbPath,
      repo_root: repoRoot,
      default_branch: defaultBranch,
      main_view_db_path: mainViewDbPath,
      purpose,
      worker_thread_id: worker.threadId,
      timeout_ms: maxMs,
    });
    worker.stderr?.on("data", (chunk) => {
      const stderr = tailText(chunk, 4000);
      if (!stderr.trim()) return;
      log.warn("atlas", "ATLAS boot worker stderr", {
        worker_thread_id: worker.threadId,
        purpose,
        stderr,
      });
    });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const stopThenTerminate = (err, reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      recordEmbeddingForensics("atlas.boot_worker_thread.stop_requested", {
        worker_thread_id: worker.threadId,
        purpose,
        reason,
        grace_ms: ATLAS_V2_BOOT_WORKER_STOP_GRACE_MS,
      });
      try { worker.postMessage({ type: "stop", reason }); } catch { /* worker may already be gone */ }
      let done = false;
      let graceTimer = null;
      const complete = () => {
        if (done) return;
        done = true;
        if (graceTimer) clearTimeout(graceTimer);
        cleanup();
        reject(err);
      };
      worker.once("exit", complete);
      graceTimer = setTimeout(() => {
        recordEmbeddingForensics("atlas.boot_worker_thread.stop_grace_expired", {
          worker_thread_id: worker.threadId,
          purpose,
          reason,
        });
        worker.terminate().catch(() => {}).finally(complete);
      }, ATLAS_V2_BOOT_WORKER_STOP_GRACE_MS);
      graceTimer.unref?.();
    };
    worker.on("message", (message = {}) => {
      if (message?.type === "progress") {
        if (typeof onProgress === "function") {
          try { onProgress(message.event || {}); } catch { /* progress is observational */ }
        }
        return;
      }
      if (message?.type === "result") {
        recordEmbeddingForensics("atlas.boot_worker_thread.result", {
          worker_thread_id: worker.threadId,
          purpose,
          result: message.result || null,
        });
        finish(resolve, message.result || {});
        return;
      }
      if (message?.type === "error") {
        const err = errorFromWorkerPayload(message.error);
        recordEmbeddingForensics("atlas.boot_worker_thread.message_error", {
          worker_thread_id: worker.threadId,
          purpose,
          error: errorForTelemetry(err),
        });
        finish(reject, err);
      }
    });
    worker.on("error", (err) => {
      const decorated = decorateWorkerError(err instanceof Error ? err : new Error(String(err)), {
        code: "ATLAS_V2_BOOT_WORKER_ERROR",
      });
      recordEmbeddingForensics("atlas.boot_worker_thread.error", {
        worker_thread_id: worker.threadId,
        purpose,
        error: errorForTelemetry(decorated),
      });
      finish(reject, decorated);
    });
    worker.on("exit", (code) => {
      if (settled) return;
      const message = code === 0
        ? "ATLAS v2 boot worker exited before returning a result"
        : `ATLAS v2 boot worker exited with code ${code}`;
      const decorated = decorateWorkerError(new Error(message), {
        code: "ATLAS_V2_BOOT_WORKER_EXIT",
        exitCode: code,
      });
      recordEmbeddingForensics("atlas.boot_worker_thread.exit", {
        worker_thread_id: worker.threadId,
        purpose,
        exit_code: code,
        error: errorForTelemetry(decorated),
      });
      finish(reject, decorated);
    });
    if (maxMs > 0) {
      timer = setTimeout(() => {
        const err = decorateWorkerError(new Error(`ATLAS v2 boot worker timed out after ${maxMs}ms`), {
          code: "ATLAS_V2_BOOT_WORKER_TIMEOUT",
          timeoutMs: maxMs,
        });
        recordEmbeddingForensics("atlas.boot_worker_thread.timeout", {
          worker_thread_id: worker.threadId,
          purpose,
          timeout_ms: maxMs,
          error: errorForTelemetry(err),
        });
        stopThenTerminate(err, "ATLAS v2 boot worker timed out");
      }, maxMs);
      timer.unref?.();
    }
  });
}

/**
 * @param {string} repoRoot
 * @param {Record<string, any>} [config]
 */
function atlasV2BootScipDir(repoRoot, config = {}) {
  return String(config?.scipDir || path.join(repoRoot, ".posse", "atlas", "scip"));
}

/**
 * @param {{ repoRoot?: string, config?: Record<string, any> }} [args]
 */
async function inspectScipBootState({ repoRoot = "", config = {} } = {}) {
  const mode = normalizeAtlasScipMode(config?.scipMode);
  if (!shouldRunScipPhase(mode)) {
    return { enabled: false, dir: null, files: [], rows: [], needsStaging: false, failedLanguages: [] };
  }
  const dir = atlasV2BootScipDir(repoRoot, config);
  const [files, staging] = await Promise.all([
    listScipFiles(dir).catch(() => []),
    describeScipStagingState({ repoRoot, scipDir: dir, config }).catch((err) => ({ rows: [], error: formatAtlasError(err) })),
  ]);
  const stagingInfo = /** @type {any} */ (staging);
  const rows = Array.isArray(stagingInfo?.rows) ? stagingInfo.rows : [];
  const needsStaging = rows.some((row) => row?.decision?.action === "stage");
  const failedLanguages = uniqueSourceLanguages(rows
    .filter((row) => String(row?.meta_status || row?.meta?.status || "").toLowerCase() === "failed")
    .flatMap((row) => Array.isArray(row?.source_languages) && row.source_languages.length > 0
      ? row.source_languages
      : [row.language]));
  return {
    enabled: true,
    dir,
    files,
    rows,
    needsStaging,
    failedLanguages,
    error: stagingInfo?.error || null,
  };
}

/**
 * @param {any} args
 */
function runAtlasV2BootWarmInWorker(args) {
  const timeoutMs = resolveAtlasV2BootTimeoutMs(args?.timeoutMs, args?.config);
  const policy = normalizeAtlasBootReindexPolicy(args?.config?.bootReindexPolicy);
  const inspectBootState = async () => {
    const ledgerPresent = fs.existsSync(args.ledgerDbPath);
    const mainViewPresent = fs.existsSync(args.mainViewDbPath);
    const viewStatus = ledgerPresent && mainViewPresent
      ? await inspectMainViewForBootInWorker({ viewPath: args.mainViewDbPath, branch: args.defaultBranch, ledgerDbPath: args.ledgerDbPath })
      : null;
    const indexCurrent = !!(ledgerPresent && mainViewPresent && viewStatus?.branchMatches && viewStatus?.current);
    const canUseIncremental = !!(
      ledgerPresent
      && mainViewPresent
      && viewStatus?.branchMatches
      && policy !== "always"
    );
    return { ledgerPresent, mainViewPresent, viewStatus, indexCurrent, canUseIncremental };
  };
  // SCIP staging (.scip generation) is no longer pre-staged here. The boot
  // worker stages SCIP out-of-process concurrently with the tree-sitter parse
  // and ingests it AFTER parse, all inside this awaited pass — so the merged
  // view reflects both the tree-sitter and SCIP layers before boot completes.
  // There is no deferral to a later ledger pass. See ParseEngine.handleWarmJob.
  return runSqliteWrite(
    args.ledgerDbPath,
    async () => {
      const { canUseIncremental } = await inspectBootState();
      // Even when the index looks current, run main-incremental: the worker's
      // boot source-stat freshness scan only hashes files whose size/mtime
      // changed, so this stays cheap while catching disk changes that never
      // reached the ledger.
      const purpose = canUseIncremental ? "main-incremental" : "main-full";
      return runAtlasV2BootWarmWorkerThread({
        ...args,
        timeoutMs,
        purpose,
      });
    },
    {
      label: "ATLAS v2 boot worker",
      waitMs: timeoutMs,
    },
  );
}

/**
 * @param {any} [args]
 */
async function runAtlasV2BootWarmWithProgress({
  onProgress = null,
  heartbeatMs = null,
  repoId = null,
  branch = null,
  task,
} = {}) {
  if (typeof task !== "function") {
    throw new Error("ATLAS v2 boot warm task is required");
  }
  const progress = typeof onProgress === "function" ? onProgress : null;
  const startedAt = Date.now();
  const elapsedMs = () => Math.max(0, Date.now() - startedAt);
  let activeStage = "warming main view";
  let activeDetail = null;
  const emitProgress = (event = {}) => {
    if (event?.stage) activeStage = String(event.stage);
    if (event?.detail || event?.text) activeDetail = String(event.detail || event.text || "");
    emitBootProgress(progress, {
      elapsedMs: elapsedMs(),
      repoId,
      branch,
      stage: activeStage,
      ...event,
    });
  };
  const tickMs = Number.isFinite(Number(heartbeatMs)) && Number(heartbeatMs) > 0
    ? Number(heartbeatMs)
    : 5000;
  let heartbeat = null;
  const emitStage = async (stage, text, extra = {}) => {
    activeStage = stage || activeStage;
    activeDetail = text || activeDetail;
    emitProgress({
      kind: "line",
      stream: "system",
      stage: activeStage,
      detail: activeDetail,
      text,
      ...extra,
    });
    await asyncBoundary();
  };
  if (progress) {
    heartbeat = setInterval(() => {
      emitProgress({
        kind: "line",
        stream: "system",
        stage: activeStage,
        detail: activeDetail,
        heartbeat: true,
        text: activeDetail || activeStage,
      });
    }, tickMs);
    heartbeat.unref?.();
  }
  try {
    await emitStage("initializing", "starting ATLAS v2 boot warm");
    const result = await task({ onProgress: emitProgress, emitStage });
    await emitStage("complete", "ATLAS v2 boot warm complete");
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function openMountedView(viewPath = null) {
  if (!viewPath || !fs.existsSync(viewPath)) return null;
  try {
    return AtlasView.mount({ dbPath: viewPath });
  } catch {
    return null;
  }
}

function stateForMountSource(source) {
  if (source === "warmed") return "mounted_warmed";
  if (source === "main-clone") return "mounted_main_clone";
  if (source === "ledger-build") return "mounted_ledger_build";
  if (source === "none") return "mounted_existing";
  return "mount_unknown";
}

function buildWorkItemScopedConfig({
  projectDir = null,
  worktreePath = null,
  workItemId = null,
  config = getAtlasIntegrationConfig(),
} = {}) {
  const baseProjectDir = projectDir ? path.resolve(projectDir) : null;
  const scopedWorktreePath = worktreePath ? path.resolve(worktreePath) : null;
  if (!baseProjectDir || !scopedWorktreePath || workItemId == null) return null;
  const primaryRepo = resolveAtlasRepoTarget({ cwd: baseProjectDir, config });
  return withAtlasConfigOverrides(config, {
    requestedRepoPath: scopedWorktreePath,
    requestedRepoId: config?.requestedRepoId || primaryRepo.repoId || null,
    requestedGraphDbPath: null,
    workItemId,
  });
}

function v2WorkItemContext({
  projectDir = null,
  worktreePath = null,
  workItemId = null,
  config = getAtlasIntegrationConfig(),
} = {}) {
  const scopedConfig = buildWorkItemScopedConfig({ projectDir, worktreePath, workItemId, config }) || config;
  const storage = repoStorageFor({ cwd: projectDir, config });
  const viewDbPath = workItemViewPath(worktreePath);
  return {
    ok: true,
    skipped: null,
    config: scopedConfig,
    repoRoot: storage.repoRoot,
    repo: resolveAtlasRepoTarget({ cwd: worktreePath || projectDir, config: scopedConfig }),
    graphDbPath: viewDbPath,
    primaryGraphDbPath: storage.mainViewDbPath,
    viewDbPath,
    mainViewDbPath: storage.mainViewDbPath,
    ledgerDbPath: storage.ledgerDbPath,
    warmedViewDbPath: warmedWorkItemViewPath(projectDir, workItemId),
    backend: "atlas-v2",
  };
}

function v2JoinResult(args = {}) {
  const config = args.config || getAtlasIntegrationConfig();
  if (!config?.enabled) return { attempted: false, skipped: "atlas_disabled", disableAtlas: false, backend: "atlas-v2" };
  if (!isAtlasIndexMaintenanceEnabled(config)) return { attempted: false, skipped: "phase_not_enabled", disableAtlas: false, backend: "atlas-v2" };
  const ctx = v2WorkItemContext(args);
  ensureParentDir(ctx.viewDbPath);
  const workItemId = args.workItemId ?? null;
  const ledgerBranch = workItemId != null ? ledgerBranchForWi(workItemId) : null;
  const baselineBranch = resolveAtlasBaselineBranch(ctx.repoRoot);
  let ledger = null;
  try {
    ledger = Ledger.open({ dbPath: ctx.ledgerDbPath });
    if (!ledger.getBranch(baselineBranch)) ledger.ensureRootBranch(baselineBranch);
    if (ledgerBranch && !ledger.getBranch(ledgerBranch)) {
      ledger.forkBranch(ledgerBranch, baselineBranch, ledger.headSeq(baselineBranch));
    }
    const warmer = new Warmer({
      ledger,
      repoRoot: ctx.repoRoot,
      defaultBranch: baselineBranch,
      config: ctx.config,
    });
    const mount = warmer.mountForWorktree({
      workItemId: workItemId ?? "unknown",
      ledgerBranch: ledgerBranch || undefined,
      worktreePath: args.worktreePath || process.cwd(),
    });
    const mounted = !!(mount.viewPath && fs.existsSync(mount.viewPath));
    return {
      attempted: true,
      skipped: null,
      disableAtlas: false,
      config: ctx.config,
      graphDbPath: ctx.graphDbPath,
      primaryGraphDbPath: ctx.primaryGraphDbPath,
      viewDbPath: ctx.viewDbPath,
      mainViewDbPath: ctx.mainViewDbPath,
      ledgerDbPath: ctx.ledgerDbPath,
      warmedViewDbPath: ctx.warmedViewDbPath,
      state: stateForMountSource(mount.from),
      backend: "atlas-v2",
      mounted,
      mount,
      view: openMountedView(mount.viewPath || ctx.viewDbPath),
    };
  } catch (err) {
    logAtlasError(`[atlas] mount failed (workItemId=${args?.workItemId}):`, err);
    if (isVerboseAtlasErrors()) throw err;
    return {
      attempted: true,
      skipped: "mount_failed",
      error: formatAtlasError(err),
      disableAtlas: false,
      config: ctx.config,
      graphDbPath: ctx.graphDbPath,
      primaryGraphDbPath: ctx.primaryGraphDbPath,
      viewDbPath: ctx.viewDbPath,
      mainViewDbPath: ctx.mainViewDbPath,
      ledgerDbPath: ctx.ledgerDbPath,
      warmedViewDbPath: ctx.warmedViewDbPath,
      state: "mount_failed",
      backend: "atlas-v2",
      mounted: false,
      view: null,
    };
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
  }
}

async function v2JoinResultAsync(args = {}) {
  const config = args.config || getAtlasIntegrationConfig();
  if (!config?.enabled) return { attempted: false, skipped: "atlas_disabled", disableAtlas: false, backend: "atlas-v2" };
  if (!isAtlasIndexMaintenanceEnabled(config)) return { attempted: false, skipped: "phase_not_enabled", disableAtlas: false, backend: "atlas-v2" };
  const ctx = v2WorkItemContext(args);
  ensureParentDir(ctx.viewDbPath);
  const workItemId = args.workItemId ?? null;
  const ledgerBranch = workItemId != null ? ledgerBranchForWi(workItemId) : null;
  const baselineBranch = await resolveAtlasBaselineBranchAsync(ctx.repoRoot);
  let ledger = null;
  try {
    ledger = Ledger.open({ dbPath: ctx.ledgerDbPath });
    if (!ledger.getBranch(baselineBranch)) {
      await ledger.ensureRootBranchAsync(baselineBranch, { label: "atlas.ensureBaselineBranch" });
    }
    if (ledgerBranch && !ledger.getBranch(ledgerBranch)) {
      await ledger.forkBranchAsync(ledgerBranch, baselineBranch, ledger.headSeq(baselineBranch), {
        label: "atlas.forkBranch",
      });
    }
    const warmer = new Warmer({
      ledger,
      repoRoot: ctx.repoRoot,
      defaultBranch: baselineBranch,
      config: ctx.config,
    });
    const mount = await warmer.mountForWorktreeAsync({
      workItemId: workItemId ?? "unknown",
      ledgerBranch: ledgerBranch || undefined,
      worktreePath: args.worktreePath || process.cwd(),
    }, { label: "atlas.mountForWorktree" });
    const mounted = !!(mount.viewPath && fs.existsSync(mount.viewPath));
    return {
      attempted: true,
      skipped: null,
      disableAtlas: false,
      config: ctx.config,
      graphDbPath: ctx.graphDbPath,
      primaryGraphDbPath: ctx.primaryGraphDbPath,
      viewDbPath: ctx.viewDbPath,
      mainViewDbPath: ctx.mainViewDbPath,
      ledgerDbPath: ctx.ledgerDbPath,
      warmedViewDbPath: ctx.warmedViewDbPath,
      state: stateForMountSource(mount.from),
      backend: "atlas-v2",
      mounted,
      mount,
      view: openMountedView(mount.viewPath || ctx.viewDbPath),
    };
  } catch (err) {
    logAtlasError(`[atlas] async mount failed (workItemId=${args?.workItemId}):`, err);
    if (isVerboseAtlasErrors()) throw err;
    return {
      attempted: true,
      skipped: "mount_failed",
      error: formatAtlasError(err),
      disableAtlas: false,
      config: ctx.config,
      graphDbPath: ctx.graphDbPath,
      primaryGraphDbPath: ctx.primaryGraphDbPath,
      viewDbPath: ctx.viewDbPath,
      mainViewDbPath: ctx.mainViewDbPath,
      ledgerDbPath: ctx.ledgerDbPath,
      warmedViewDbPath: ctx.warmedViewDbPath,
      state: "mount_failed",
      backend: "atlas-v2",
      mounted: false,
      view: null,
    };
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
  }
}

export function getAtlasProviderSupport(providerName, {
  config = getAtlasIntegrationConfig(),
} = {}) {
  const support = getConfiguredAtlasProviderSupport(providerName, { config });
  const transport = support.transport === "mcp" ? POSSE_MCP_GATEWAY_TRANSPORT : support.transport;
  return {
    ...support,
    transport,
    configured: !!config.enabled,
    active: support.supported && !!config.enabled,
    backend: "atlas-v2",
  };
}

export function buildAtlasProcessEnv({ cwd = null, config = getAtlasIntegrationConfig(), ensureDir = true } = {}) {
  const storage = repoStorageFor({ cwd, config });
  if (ensureDir) {
    ensureParentDir(storage.ledgerDbPath);
    ensureParentDir(storage.mainViewDbPath);
  }
  return {
    ATLAS_V2_LEDGER_DB_PATH: storage.ledgerDbPath,
    ATLAS_V2_MAIN_VIEW_DB_PATH: storage.mainViewDbPath,
    ATLAS_GRAPH_DB_PATH: storage.ledgerDbPath,
    ATLAS_DB_PATH: storage.ledgerDbPath,
  };
}

export async function buildAtlasProcessEnvAsync({ cwd = null, config = getAtlasIntegrationConfig(), ensureDir = true, signal = null } = {}) {
  const storage = await repoStorageForAsync({ cwd, config, signal });
  if (ensureDir) {
    ensureParentDir(storage.ledgerDbPath);
    ensureParentDir(storage.mainViewDbPath);
  }
  return {
    ATLAS_V2_LEDGER_DB_PATH: storage.ledgerDbPath,
    ATLAS_V2_MAIN_VIEW_DB_PATH: storage.mainViewDbPath,
    ATLAS_GRAPH_DB_PATH: storage.ledgerDbPath,
    ATLAS_DB_PATH: storage.ledgerDbPath,
  };
}

/**
 * @param {any} [args]
 */
export function buildAtlasRuntimeConfigPayload({ repo, graphDbPath, config = getAtlasIntegrationConfig() } = {}) {
  const storage = repoStorageFor({ cwd: repo?.repoPath, config });
  return {
    atlasVersion: "v2",
    repo: {
      repoId: repo?.repoId || storage.repo.repoId || null,
      rootPath: repo?.repoPath || storage.repo.repoPath || null,
    },
    ledger: { path: graphDbPath || storage.ledgerDbPath },
    views: { main: storage.mainViewDbPath },
    semantic: { enabled: config?.semanticEnabled === true },
    vectorBackend: config?.vectorBackend || null,
  };
}

export function buildWorkItemAtlasConfig(opts = {}) {
  return buildWorkItemScopedConfig(opts);
}

export function resolveAtlasGraphDbPath(opts = {}) {
  return repoStorageFor({ cwd: opts?.cwd, config: opts?.config || getAtlasIntegrationConfig() }).ledgerDbPath;
}

export async function resolveAtlasGraphDbPathAsync(opts = {}) {
  return (await repoStorageForAsync({
    cwd: opts?.cwd,
    config: opts?.config || getAtlasIntegrationConfig(),
    signal: opts?.signal,
  })).ledgerDbPath;
}

export function resolveWorkItemAtlasGraphDbPath(opts = {}) {
  return workItemViewPath(opts?.worktreePath || opts?.repoPath || opts?.projectDir);
}

export function resolveWorkItemAtlasGraphRoot(opts = {}) {
  const viewPath = warmedWorkItemViewPath(opts?.projectDir, opts?.workItemId);
  return viewPath ? path.dirname(viewPath) : null;
}

export function buildAtlasIndexInvocation(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  return {
    command: null,
    args: [],
    cwd: storage.repo.repoPath || opts?.cwd || process.cwd(),
    env: buildAtlasProcessEnv(opts),
    source: "atlas-v2-native",
    repoId: storage.repo.repoId || null,
    backend: "atlas-v2",
    ready: true,
  };
}

export function buildAtlasServerSpec(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  return {
    name: config.serverName || "atlas-v2",
    transport: "v2",
    installPath: null,
    workingDir: storage.repo.repoPath || opts?.cwd || null,
    cwd: storage.repo.repoPath || opts?.cwd || null,
    env: buildAtlasProcessEnv(opts),
    command: null,
    args: [],
    url: null,
    source: "atlas-v2-native",
    ready: !!config.enabled,
    backend: "atlas-v2",
    repoId: storage.repo.repoId || null,
    ledgerDbPath: storage.ledgerDbPath,
    viewDbPath: storage.mainViewDbPath,
  };
}

export function resolveAtlasNodeCommand() {
  return process.execPath;
}

export function seedWorkItemAtlasGraphFromPrimary(opts = {}) {
  return {
    ok: true,
    skipped: "atlas_v2_uses_ledger_views",
    copied: [],
    backend: "atlas-v2",
    primaryGraphDbPath: opts?.primaryGraphDbPath || null,
    workItemGraphDbPath: opts?.workItemGraphDbPath || null,
  };
}

export async function seedWorkItemAtlasGraphFromPrimaryAsync(opts = {}) {
  return seedWorkItemAtlasGraphFromPrimary(opts);
}

export function disposeWorkItemAtlasGraph(opts = {}) {
  const includeWarmed = opts?.includeWarmed !== false;
  const includeWorktree = opts?.includeWorktree !== false;
  const targets = [
    includeWarmed ? warmedWorkItemViewPath(opts?.projectDir, opts?.workItemId) : null,
    includeWorktree && opts?.worktreePath ? workItemViewPath(opts.worktreePath) : null,
  ].filter(Boolean);
  if (targets.length === 0) return { ok: false, skipped: "missing_path", root: null, backend: "atlas-v2" };
  const removed = [];
  const errors = [];
  for (const target of targets) {
    try {
      fs.rmSync(target, { force: true });
      fs.rmSync(`${target}-wal`, { force: true });
      fs.rmSync(`${target}-shm`, { force: true });
      removed.push(target);
    } catch (err) {
      errors.push({ path: target, error: String(err?.message || err || "unknown") });
    }
  }
  return {
    ok: errors.length === 0,
    root: targets[0] ? path.dirname(targets[0]) : null,
    viewDbPath: targets[0] || null,
    removed,
    errors,
    backend: "atlas-v2",
  };
}

export function resolveWorkItemAtlasContext(opts = {}) {
  return v2WorkItemContext({ ...opts, config: opts?.config || getAtlasIntegrationConfig() });
}

export function ensureWorkItemAtlasJoin(opts = {}) {
  return v2JoinResult({ ...opts, config: opts?.config || getAtlasIntegrationConfig() });
}

export async function ensureWorkItemAtlasJoinAsync(opts = {}) {
  return await v2JoinResultAsync({ ...opts, config: opts?.config || getAtlasIntegrationConfig() });
}

export function probeAtlasGraphReadiness(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  const graphDbPath = opts?.graphDbPath || resolveAtlasGraphDbPath({ ...opts, config });
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  const viewPath = opts?.viewDbPath || storage.mainViewDbPath;
  const ledgerOk = !!graphDbPath && fs.existsSync(graphDbPath);
  const viewExists = !!viewPath && fs.existsSync(viewPath);
  let viewOk = false;
  let meta = null;
  let freshness = null;
  let viewError = null;
  if (viewExists) {
    const probe = openViewWithMeta(viewPath, AtlasView);
    try {
      if (probe.ok) {
        viewOk = true;
        meta = probe.meta || null;
      } else {
        viewError = probe.error?.message || String(probe.error || "view_unreadable");
      }
    } finally {
      try { if (probe.ok) probe.view.close(); } catch { /* ignore */ }
    }
  }
  if (ledgerOk && meta) {
    let ledger = null;
    try {
      ledger = Ledger.open({ dbPath: graphDbPath });
      freshness = viewFreshness(meta, ledger);
    } catch (err) {
      freshness = {
        current: false,
        branch: meta.branch,
        ledgerSeq: meta.ledger_seq,
        headSeq: null,
        reason: err?.message || String(err),
      };
    } finally {
      try { ledger?.close?.(); } catch { /* ignore */ }
    }
  }
  const usable = !!(ledgerOk && viewOk && (!freshness || freshness.current));
  const reason = usable
    ? null
    : (!ledgerOk
        ? "atlas_v2_ledger_missing"
        : (!viewOk ? (viewError || "atlas_v2_view_missing") : (freshness?.reason || "atlas_v2_view_stale")));
  return {
    attempted: true,
    ok: ledgerOk && viewOk,
    usable,
    reason,
    backend: "atlas-v2",
    graphDbPath,
    viewDbPath: viewPath,
    branch: meta?.branch || null,
    ledgerSeq: meta?.ledger_seq ?? null,
    headSeq: freshness?.headSeq ?? null,
    freshness,
  };
}

export async function probeAtlasGraphReadinessAsync(opts = {}) {
  return probeAtlasGraphReadiness(opts);
}

let _atlasV2DepsPrewarmPromise = null;
export function prewarmAtlasV2BootDeps() {
  if (_atlasV2DepsPrewarmPromise) return _atlasV2DepsPrewarmPromise;
  _atlasV2DepsPrewarmPromise = Promise.all([
    import("../../atlas/classes/v2/Ledger.js"),
    import("../../atlas/classes/v2/Warmer.js"),
    import("../../atlas/functions/v2/parser/adapter.js"),
  ]).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, error: err }),
  );
  return _atlasV2DepsPrewarmPromise;
}

/**
 * Whether the warm pipeline's embeddings stage is configured to run at all.
 * Mirrors the gates `openEmbeddingResources` applies before opening an encoder.
 */
function atlasEmbeddingsConfigured(config) {
  return !!config && embeddingsExplicitlyEnabled(config) && configuredVectorBackend(config) !== "off";
}

/**
 * Rest the TUI readiness bars on the boot warm's REAL outcome, so a session
 * that booted with a current index reads "ready" instead of "idle", and ONNX
 * reads "off" only when embeddings are genuinely disabled (see warm-progress.js
 * honesty contract).
 *
 * @param {{ ok: boolean, result?: any, config?: any }} args
 */
function seedAtlasBootReadiness({ ok, result = null, config = null }) {
  const embeddingsOn = atlasEmbeddingsConfigured(config);
  /** @type {Parameters<typeof warmReadinessSeed>[0]} */
  const seed = { atlasEnabled: true, onnxEnabled: embeddingsOn };
  if (ok) {
    seed.atlas = 100;
    if (!embeddingsOn) {
      seed.onnx = null;
    } else {
      const candidates = Number(result?.embeddings_candidates);
      const covered = (Number(result?.embeddings_indexed) || 0)
        + (Number(result?.embeddings_already_indexed) || 0);
      if (result?.embeddings_error) {
        // Encoder/index trouble: rest at the reported coverage (or 0) so the
        // bar honestly reads "incomplete" rather than "ready" or "off".
        seed.onnx = Number.isFinite(candidates) && candidates > 0
          ? (covered / candidates) * 100
          : 0;
      } else if (Number.isFinite(candidates)) {
        seed.onnx = candidates > 0 ? (covered / candidates) * 100 : 100;
      } else {
        // Warm succeeded without reporting embeddings work: the freshness
        // scan found nothing to encode, so the on-disk index is current.
        seed.onnx = 100;
      }
    }
  }
  // On failure: keep whatever percents the live progress events left behind
  // (honest partial), but still record enablement so labels read correctly.
  warmReadinessSeed(seed);
}

export async function ensureAtlasRepoIndexedOnBoot(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  if (!shouldUseAtlasV2({ config }) || !config?.enabled || !isAtlasIndexMaintenanceEnabled(config)) {
    // No warm will ever run this session — both bars honestly read "off".
    warmReadinessSeed({ atlas: null, onnx: null, atlasEnabled: false, onnxEnabled: false });
    const skipped = (!shouldUseAtlasV2({ config }) || !config?.enabled) ? "atlas_disabled" : "phase_not_enabled";
    return { attempted: false, skipped, backend: "atlas-v2" };
  }
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  await asyncBoundary();
  const baselineBranch = await resolveAtlasBaselineBranchAsync(storage.repoRoot);
  ensureParentDir(storage.ledgerDbPath);
  const [ledgerPresent, mainViewPresent] = await Promise.all([
    fs.promises.access(storage.ledgerDbPath).then(() => true, () => false),
    fs.promises.access(storage.mainViewDbPath).then(() => true, () => false),
  ]);
  const bootReindexPolicy = normalizeAtlasBootReindexPolicy(config?.bootReindexPolicy);
  const viewStatus = ledgerPresent && mainViewPresent
    ? await inspectMainViewForBootInWorker({ viewPath: storage.mainViewDbPath, branch: baselineBranch, ledgerDbPath: storage.ledgerDbPath })
    : null;
  const indexPresent = !!(ledgerPresent && mainViewPresent && viewStatus?.branchMatches && viewStatus?.current);
  const canUseExistingIndex = indexPresent && bootReindexPolicy !== "always";
  // Decide whether ATLAS itself can be skipped (index already current and
  // boot policy isn't forcing a rebuild). SCIP staging runs concurrently in
  // the background regardless of this skip — it has its own freshness logic
  // and writes only to .posse/atlas/scip/<lang>.scip, not the ledger. But
  // if there are already-staged SCIP files on disk that the ledger hasn't
  // ingested, we still need the worker to do that ingest pass (the ingester
  // is idempotent so this is fast when nothing's new).
  if (canUseExistingIndex) {
    const scipState = await inspectScipBootState({ repoRoot: storage.repoRoot, config });
    if (scipState.needsStaging) {
      emitBootProgress(opts?.onProgress, {
        kind: "line",
        stream: "system",
        stage: "scip",
        text: `SCIP boot check: retrying ${scipState.failedLanguages.length > 0 ? scipState.failedLanguages.join(",") : "missing"} staging`,
      });
    }
    // Fall through to runAtlasV2BootWarmInWorker. Even when the view is
    // current, the worker now performs a source-stat freshness scan so disk
    // changes that never reached the ledger can feed a partial warm.
  }
  // Fold boot warm progress into the live readiness bars too. During a normal
  // boot the TUI isn't up yet (harmless), but when the operator backgrounds
  // the ONNX encode and enters the TUI early, the bars sweep live instead of
  // resting on a stale "idle"/"off".
  const callerOnProgress = opts?.onProgress;
  const onProgressWithReadiness = (event) => {
    try { warmReadinessProgress(event); } catch { /* observational */ }
    if (typeof callerOnProgress === "function") callerOnProgress(event);
  };
  warmReadinessStarted();
  try {
    const result = await runAtlasV2BootWarmWithProgress({
      onProgress: onProgressWithReadiness,
      heartbeatMs: opts?.heartbeatMs,
      repoId: storage.repo.repoId || null,
      branch: baselineBranch,
      task: async (progressArgs = {}) => {
        const { onProgress, emitStage } = /** @type {any} */ (progressArgs);
        await emitStage?.("worker", "starting ATLAS boot worker");
        return await runAtlasV2BootWarmInWorker({
          ledgerDbPath: storage.ledgerDbPath,
          repoRoot: storage.repoRoot,
          defaultBranch: baselineBranch,
          mainViewDbPath: storage.mainViewDbPath,
          config,
          onProgress,
          timeoutMs: opts?.timeoutMs ?? config?.bootTimeoutMs ?? getAtlasV2BootTimeoutMs(),
          testBlockMs: Number(opts?.__testWorkerBlockMs || 0),
        });
      },
    });
    seedAtlasBootReadiness({ ok: true, result, config });
    return {
      attempted: true,
      ok: true,
      status: 0,
      backend: "atlas-v2",
      result,
      ledgerDbPath: storage.ledgerDbPath,
      viewDbPath: storage.mainViewDbPath,
      graphDbPath: storage.ledgerDbPath,
      repoId: storage.repo.repoId || null,
      branch: baselineBranch,
    };
  } catch (err) {
    seedAtlasBootReadiness({ ok: false, config });
    logAtlasError(`[atlas] ensureAtlasRepoIndexedOnBoot (repoRoot=${storage.repoRoot}):`, err);
    if (isVerboseAtlasErrors()) throw err;
    return {
      attempted: true,
      ok: false,
      status: 1,
      backend: "atlas-v2",
      error: formatAtlasError(err),
      ledgerDbPath: storage.ledgerDbPath,
      viewDbPath: storage.mainViewDbPath,
      graphDbPath: storage.ledgerDbPath,
      repoId: storage.repo.repoId || null,
      branch: baselineBranch,
    };
  }
}

/**
 * Pre-flight gate helper. Decides — off the main thread — whether the ATLAS
 * index is cold (missing/stale) or warm, and kicks the boot index build in the
 * worker. Callers gate job dispatch on `ready` ONLY when `cold` is true, so the
 * initial full build completes before the main loop runs jobs; a warm index
 * returns `cold:false` and its `ready` is the (non-gating) incremental re-warm.
 * `ready` also rejects-safe: dispatch should resolve the gate on rejection so a
 * failed build degrades ATLAS rather than wedging the queue.
 *
 * @param {{ cwd?: string, config?: any, onProgress?: ((e:any)=>void)|null, heartbeatMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ cold: boolean, attempted: boolean, ready: Promise<any> }>}
 */
export async function startAtlasPreflightIndex(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  if (!shouldUseAtlasV2({ config }) || !config?.enabled || !isAtlasIndexMaintenanceEnabled(config)) {
    return { cold: false, attempted: false, ready: Promise.resolve({ attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" }) };
  }
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  const baselineBranch = await resolveAtlasBaselineBranchAsync(storage.repoRoot);
  const [ledgerPresent, mainViewPresent] = await Promise.all([
    fs.promises.access(storage.ledgerDbPath).then(() => true, () => false),
    fs.promises.access(storage.mainViewDbPath).then(() => true, () => false),
  ]);
  let viewCurrent = false;
  if (ledgerPresent && mainViewPresent) {
    try {
      const status = await inspectMainViewForBootInWorker({
        viewPath: storage.mainViewDbPath,
        branch: baselineBranch,
        ledgerDbPath: storage.ledgerDbPath,
      });
      viewCurrent = !!(status?.branchMatches && status?.current);
    } catch {
      viewCurrent = false;
    }
  }
  const cold = !viewCurrent;
  // Build runs in the worker (main-full when cold, main-incremental when warm).
  const ready = ensureAtlasRepoIndexedOnBoot({ ...opts, config });
  return { cold, attempted: true, ready };
}

export function isAtlasGraphCorruptionError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("sqlite_corrupt")
    || text.includes("database disk image is malformed")
    || text.includes("file is not a database")
    || text.includes("database schema is corrupt");
}

function isLikelyAtlasV2LedgerPath(graphDbPath) {
  const value = String(graphDbPath || "").trim();
  if (!value) return false;
  const normalized = path.normalize(value);
  return path.basename(normalized).toLowerCase() === "ledger.db"
    && path.basename(path.dirname(normalized)).toLowerCase() === "atlas";
}

function recoveryTargets(dbPath) {
  const normalized = path.normalize(String(dbPath || ""));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (isLikelyAtlasV2LedgerPath(normalized)) {
    const atlasRoot = path.dirname(normalized);
    return {
      stamp,
      viewsDir: path.join(atlasRoot, "views"),
      quarantineDir: path.join(atlasRoot, "recovery"),
      files: [normalized, `${normalized}-wal`, `${normalized}-shm`, `${normalized}-journal`],
    };
  }
  return {
    stamp,
    viewsDir: null,
    quarantineDir: path.join(path.dirname(normalized), "recovery"),
    files: [normalized, `${normalized}-wal`, `${normalized}-shm`, `${normalized}-journal`],
  };
}

export function attemptAtlasGraphRecovery(graphDbPath) {
  const targets = recoveryTargets(graphDbPath);
  const removed = [];
  const quarantined = [];
  const errors = [];
  try { fs.mkdirSync(targets.quarantineDir, { recursive: true }); } catch { /* best effort */ }
  if (targets.viewsDir && fs.existsSync(targets.viewsDir)) {
    try {
      fs.rmSync(targets.viewsDir, { recursive: true, force: true });
      removed.push(targets.viewsDir);
    } catch (err) {
      errors.push({ path: targets.viewsDir, error: String(err?.message || err) });
    }
  }
  for (const filePath of targets.files) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const target = path.join(targets.quarantineDir, `${path.basename(filePath)}.${targets.stamp}.bak`);
      fs.renameSync(filePath, target);
      quarantined.push({ from: filePath, to: target });
    } catch (err) {
      errors.push({ path: filePath, error: String(err?.message || err) });
    }
  }
  if (targets.viewsDir) {
    try { fs.mkdirSync(targets.viewsDir, { recursive: true }); } catch { /* best effort */ }
  }
  return {
    ok: errors.length === 0,
    errors,
    removed,
    quarantined,
    graphDbPath,
    ledgerDbPath: isLikelyAtlasV2LedgerPath(graphDbPath) ? graphDbPath : null,
    backend: "atlas-v2",
  };
}

export async function attemptAtlasGraphRecoveryAsync(graphDbPath, { signal = null } = {}) {
  if (signal?.aborted) throw signal.reason ?? new Error("ATLAS recovery aborted");
  return attemptAtlasGraphRecovery(graphDbPath);
}

export function reindexAtlasAfterCommit(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  ensureParentDir(storage.ledgerDbPath);
  return {
    attempted: false,
    skipped: "atlas_v2_outbox",
    ok: true,
    backend: "atlas-v2",
    repoId: storage.repo.repoId || null,
    source: "atlas-v2-native",
    ledgerDbPath: storage.ledgerDbPath,
  };
}

export async function warmAtlasMergedToMainNow(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  if (!shouldUseAtlasV2({ config })) return { attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" };
  if (!config?.enabled) return { attempted: false, skipped: "atlas_disabled", backend: "atlas-v2" };
  if (!isAtlasIndexMaintenanceEnabled(config)) return { attempted: false, skipped: "phase_not_enabled", backend: "atlas-v2" };
  const workItemId = Number(opts?.workItemId ?? opts?.wiId);
  if (!Number.isFinite(workItemId) || workItemId <= 0) {
    return { attempted: false, skipped: "missing_work_item_id", backend: "atlas-v2" };
  }

  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  const targetBranch = String(opts?.targetBranch || await resolveAtlasBaselineBranchAsync(storage.repoRoot) || "main").trim() || "main";
  const sourceBranch = String(opts?.sourceBranch || ledgerBranchForWi(workItemId)).trim();
  ensureParentDir(storage.ledgerDbPath);

  let ledger = null;
  try {
    ledger = Ledger.open({ dbPath: storage.ledgerDbPath });
    const source = ledger.getBranch(sourceBranch);
    if (!source) {
      return {
        attempted: false,
        skipped: "source_branch_missing",
        backend: "atlas-v2",
        ledgerDbPath: storage.ledgerDbPath,
        viewDbPath: storage.mainViewDbPath,
        branch: targetBranch,
        sourceBranch,
        workItemId,
      };
    }
    if (!ledger.getBranch(targetBranch)) {
      await ledger.ensureRootBranchAsync(targetBranch, { label: "atlas.mergeWarm.ensureTargetBranch" });
    }
    const warmer = new Warmer({
      ledger,
      repoRoot: storage.repoRoot,
      defaultBranch: targetBranch,
      config,
      onProgress: typeof opts?.onProgress === "function" ? opts.onProgress : null,
    });
    const result = await warmer.handleWarmJob({
      purpose: "main-merge",
      work_item_id: workItemId,
      branch: sourceBranch,
      onto_branch: targetBranch,
      out_view_path: storage.mainViewDbPath,
      trigger_event: opts?.triggerEvent || "merge_wrapup",
    });
    return {
      attempted: true,
      ok: true,
      backend: "atlas-v2",
      result,
      ledgerDbPath: storage.ledgerDbPath,
      viewDbPath: storage.mainViewDbPath,
      graphDbPath: storage.ledgerDbPath,
      repoId: storage.repo.repoId || null,
      branch: targetBranch,
      sourceBranch,
      workItemId,
    };
  } catch (err) {
    logAtlasError(`[atlas] warmAtlasMergedToMainNow (repoRoot=${storage.repoRoot}, wi=${workItemId}):`, err);
    if (isVerboseAtlasErrors()) throw err;
    return {
      attempted: true,
      ok: false,
      backend: "atlas-v2",
      error: formatAtlasError(err),
      ledgerDbPath: storage.ledgerDbPath,
      viewDbPath: storage.mainViewDbPath,
      graphDbPath: storage.ledgerDbPath,
      repoId: storage.repo.repoId || null,
      branch: targetBranch,
      sourceBranch,
      workItemId,
    };
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
  }
}

function shouldAutoRestageScip(config = {}) {
  const policy = String(config?.scipRestagePolicy || "missing").trim().toLowerCase();
  return shouldRunScipPhase(normalizeAtlasScipMode(config?.scipMode)) && (policy === "smart" || policy === "always");
}

export function reconcileAtlasDriftIfIdle(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  if (config.driftCheckEnabled !== true) return { skipped: "drift_check_disabled", backend: "atlas-v2" };
  if (shouldAutoRestageScip(config)) {
    return { skipped: "async_required_for_scip_restage", backend: "atlas-v2" };
  }
  return { skipped: "atlas_v2_views_rebuildable", backend: "atlas-v2" };
}

export async function reconcileAtlasDriftIfIdleAsync(opts = {}) {
  const config = opts?.config || getAtlasIntegrationConfig();
  if (config.driftCheckEnabled !== true) return { skipped: "drift_check_disabled", backend: "atlas-v2" };
  const idle = typeof opts?.isWorkerIdle === "function" ? !!opts.isWorkerIdle() : true;
  if (!idle) return { skipped: "workers_busy", backend: "atlas-v2" };
  const storage = repoStorageFor({ cwd: opts?.cwd, config });
  if (shouldAutoRestageScip(config)) {
    const staged = await ensureScipStaged({
      repoRoot: storage.repoRoot,
      config,
      onProgress: opts?.onProgress,
    });
    return {
      attempted: staged.staged === true,
      skipped: staged.staged ? undefined : (staged.reason || "scip_restaged_not_needed"),
      backend: "atlas-v2",
      scip: staged,
    };
  }
  return { skipped: "atlas_v2_views_rebuildable", backend: "atlas-v2" };
}

export function ensureAtlasCommitReindexHook({
  cwd = null,
  config = getAtlasIntegrationConfig(),
  execImpl = spawnSync,
} = {}) {
  const repoCwd = path.resolve(cwd || process.cwd());
  const hooksDir = resolveAtlasGitHooksDir(repoCwd, execImpl);
  if (!hooksDir) {
    return {
      attempted: false,
      skipped: "not_git_repo",
      ok: true,
      backend: "atlas-v2",
      hookPath: null,
      changed: false,
    };
  }

  const hookPath = path.join(hooksDir, "post-commit");
  const shouldInstall = !!(
    config?.reindexOnCommit === true
    && config?.enabled
    && shouldUseAtlasV2({ config })
    && isAtlasIndexMaintenanceEnabled(config)
  );

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "";
    const strippedWithoutAtlas = stripManagedHookBlock(existing, ATLAS_POST_COMMIT_HOOK_BEGIN, ATLAS_POST_COMMIT_HOOK_END);
    const withoutLegacySdl = stripManagedHookBlock(
      strippedWithoutAtlas,
      LEGACY_SDL_POST_COMMIT_HOOK_BEGIN,
      LEGACY_SDL_POST_COMMIT_HOOK_END,
    );
    const stripped = withoutLegacySdl;
    const legacySdlRemoved = withoutLegacySdl !== strippedWithoutAtlas;

    let next = stripped.trim() ? `${stripped.trimEnd()}\n\n` : "";
    if (shouldInstall) {
      next = `${next || "#!/bin/sh\n\n"}${buildAtlasPostCommitHookBlock(repoCwd)}\n`;
    }

    if (!next.trim()) {
      const changed = existing.trim() !== "";
      if (changed) {
        try { fs.rmSync(hookPath, { force: true }); } catch { /* ignore */ }
      }
      return {
        attempted: true,
        ok: true,
        backend: "atlas-v2",
        hookPath,
        changed,
        installed: false,
        removed: changed,
        legacySdlRemoved,
        skipped: shouldInstall ? undefined : "commit_hook_disabled",
      };
    }

    const normalizedNext = next.startsWith("#!") ? next : `#!/bin/sh\n\n${next}`;
    const changed = normalizedNext !== existing;
    if (changed) {
      const tmpPath = `${hookPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, normalizedNext, "utf8");
      try { fs.chmodSync(tmpPath, 0o755); } catch { /* ignore */ }
      fs.renameSync(tmpPath, hookPath);
    } else {
      try { fs.chmodSync(hookPath, 0o755); } catch { /* ignore */ }
    }
    return {
      attempted: true,
      ok: true,
      backend: "atlas-v2",
      hookPath,
      changed,
      installed: shouldInstall,
      removed: false,
      legacySdlRemoved,
      skipped: shouldInstall ? undefined : "commit_hook_disabled",
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      backend: "atlas-v2",
      hookPath,
      changed: false,
      installed: false,
      removed: false,
      error: String(err?.message || err || "unknown"),
    };
  }
}

function filteredRouteTools(route = {}) {
  return cloneArray(route.tools).filter(isExternallyRoutedAtlasTool);
}

export function buildDisabledAtlasAttachment({
  role = "unknown",
  providerName = "claude",
  reason = "disabled",
} = {}) {
  return {
    provider: normalizeProvider(providerName),
    transport: "none",
    supported: false,
    configured: false,
    role: normalizeRole(role),
    phase: null,
    shouldAdvertise: false,
    fallback: null,
    rationale: `ATLAS disabled: ${reason}`,
    repo: null,
    server: null,
    active: false,
    method: "disabled",
    split: null,
    required: false,
    failClosed: false,
    requiredFailureReason: null,
    tools: [],
    internalTools: [],
    backend: "atlas-v2",
  };
}

export function buildAtlasCapability(role, {
  cwd = null,
  config = getAtlasIntegrationConfig(),
} = {}) {
  if (!config?.enabled) {
    return {
      ...buildDisabledAtlasAttachment({ role, reason: "atlas_disabled" }),
      ready: false,
    };
  }
  const route = getAtlasRouteForRole(role, { config });
  const storage = repoStorageFor({ cwd, config });
  return {
    ...route,
    tools: filteredRouteTools(route),
    fallback: resolveFallbackMode(config),
    repo: storage.repo,
    server: null,
    ready: true,
    active: !!route.shouldAdvertise,
    backend: "atlas-v2",
    internalTools: cloneArray(route.internalTools || route.tools),
    unavailableReason: route.shouldAdvertise ? null : "atlas_route_inactive",
    ledgerDbPath: storage.ledgerDbPath,
    viewDbPath: storage.mainViewDbPath,
    view: openMountedView(storage.mainViewDbPath),
  };
}

function resolveV2SplitAssignment({
  config,
  route,
  support,
  provider,
  storage,
  assignmentUnit,
  workItemId,
}) {
  if (config?.abEnabled !== true) return null;
  if (!support?.supported || !route?.shouldAdvertise) return null;
  const normalizedAssignment = resolveAtlasAssignmentUnit({ workItemId, fallback: assignmentUnit });
  const hasWorkItemAssignment = String(normalizedAssignment || "").startsWith("wi:");
  const adaptiveTarget = loadAdaptiveSplitTarget({
    role: hasWorkItemAssignment ? "*" : (route.role || "*"),
    provider: hasWorkItemAssignment ? "*" : (provider || "*"),
  });
  return resolveSplitAssignment({
    role: route.role,
    provider,
    repo: storage.repo,
    adaptiveTarget,
    assignmentUnit: normalizedAssignment,
  });
}

export function resolveAtlasExecutionAttachment(args = {}) {
  const {
    role,
    providerName = "claude",
    cwd = null,
    assignmentUnit = null,
    workItemId = null,
    disableAtlas = false,
    disabledReason = "disabled",
    config = getAtlasIntegrationConfig(),
  } = args;
  if (disableAtlas) return buildDisabledAtlasAttachment({ role, providerName, reason: disabledReason });
  if (!config?.enabled || !isAuthoritativeAtlasV2Mode(config?.atlasV2Mode)) {
    return buildDisabledAtlasAttachment({ role, providerName, reason: "atlas_disabled" });
  }

  const provider = normalizeProvider(providerName);
  const support = getAtlasProviderSupport(provider, { config });
  const route = getAtlasRouteForRole(role, { config });
  const storage = repoStorageFor({ cwd, config });
  const required = (config.normalizedMode || config.mode) === "required";
  const baseActive = !!(support.supported && route.shouldAdvertise);
  const split = resolveV2SplitAssignment({
    config,
    route,
    support,
    provider,
    storage,
    assignmentUnit,
    workItemId,
  });
  const active = split ? !!(baseActive && split.treatment) : baseActive;
  const method = split ? split.method : "atlas-v2";
  const unavailableReason = active ? null : (split && baseActive ? "atlas_split_control" : "atlas_route_inactive");
  const failClosed = !!(required && route.shouldAdvertise && !active);
  return {
    provider,
    transport: support.transport,
    supported: support.supported,
    configured: !!config.enabled,
    role: route.role,
    phase: route.phase,
    shouldAdvertise: route.shouldAdvertise,
    fallback: resolveFallbackMode(config),
    rationale: route.rationale,
    repo: storage.repo,
    server: null,
    active,
    method,
    split,
    required,
    failClosed,
    requiredFailureReason: failClosed ? unavailableReason : null,
    tools: active ? filteredRouteTools(route) : [],
    internalTools: active ? cloneArray(route.internalTools || route.tools) : [],
    backend: "atlas-v2",
    unavailableReason,
    ledgerDbPath: storage.ledgerDbPath,
    viewDbPath: storage.mainViewDbPath,
  };
}

/**
 * @param {any} [args]
 */
export function logAtlasAttachment({
  attachment,
  jobId = null,
  workItemId = null,
  providerName = null,
  role = null,
} = {}) {
  if (!attachment) return;
  if (!attachment.shouldAdvertise && !attachment.failClosed) return;
  const data = {
    jobId,
    wiId: workItemId,
    provider: providerName || attachment.provider || null,
    role: role || attachment.role || null,
    method: attachment.method || null,
    active: !!attachment.active,
    transport: attachment.transport || null,
    tools: Array.isArray(attachment.tools) ? attachment.tools.length : 0,
    backend: attachment.backend || "atlas-v2",
  };
  if (attachment.requiredFailureReason) data.failReason = attachment.requiredFailureReason;
  if (attachment.split) {
    data.splitTreatment = !!attachment.split.treatment;
    if (attachment.split.assignment != null) data.splitAssignment = attachment.split.assignment;
  }
  const level = attachment.failClosed ? "warn" : "info";
  log[level]("atlas", attachment.failClosed ? "Attachment blocked (required mode)" : "Attachment resolved", data);
}

export function buildAtlasMcpServerConfig(role, opts = {}) {
  void role;
  return buildAtlasServerSpec(opts);
}

export function buildAtlasIntegrationPlan({ config = getAtlasIntegrationConfig() } = {}) {
  return ATLAS_ROLE_ORDER.map((role) => {
    const route = getAtlasRouteForRole(role, { config });
    return {
      role,
      phase: route.phase,
      tools: filteredRouteTools(route),
      internalTools: cloneArray(route.internalTools || route.tools),
      shouldAdvertise: route.shouldAdvertise,
      active: !!route.shouldAdvertise,
      liveFunnel: config.liveFunnel,
      mode: config.mode,
      backend: "atlas-v2",
      unavailableReason: route.shouldAdvertise ? null : "atlas_route_inactive",
    };
  });
}

export function shouldUseAtlasInLiveFunnel(role, { config = getAtlasIntegrationConfig() } = {}) {
  return !!getAtlasRouteForRole(role, { config })?.shouldAdvertise;
}

export function summarizeAtlasIntegrationPlan({ config = getAtlasIntegrationConfig() } = {}) {
  return buildAtlasIntegrationPlan({ config }).map((entry) => ({
    role: entry.role,
    phase: entry.phase,
    active: entry.active,
    shouldAdvertise: entry.shouldAdvertise,
    tools: entry.tools.length,
    backend: "atlas-v2",
    unavailableReason: entry.unavailableReason,
  }));
}

export default {
  buildAtlasCapability,
  buildAtlasIntegrationPlan,
  buildAtlasMcpServerConfig,
  buildAtlasProcessEnv,
  buildAtlasServerSpec,
  disposeWorkItemAtlasGraph,
  ensureAtlasRepoIndexedOnBoot,
  ensureWorkItemAtlasJoin,
  getAtlasIntegrationConfig,
  getAtlasProviderSupport,
  probeAtlasGraphReadiness,
  reconcileAtlasDriftIfIdle,
  reconcileAtlasDriftIfIdleAsync,
  reindexAtlasAfterCommit,
  resolveAtlasExecutionAttachment,
  resolveAtlasRepoTarget,
  seedWorkItemAtlasGraphFromPrimary,
  shouldUseAtlasInLiveFunnel,
  summarizeAtlasIntegrationPlan,
  warmAtlasMergedToMainNow,
};
