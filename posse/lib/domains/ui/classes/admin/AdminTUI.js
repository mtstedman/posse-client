// lib/admin.js — Admin TUI for stats, work-item logs, and settings management
//
// Standalone TUI that uses alternate screen + raw mode.
// Tabs: Settings | Overview | Work Items | Logs | ATLAS Report
// Navigation: 1-6 or Tab to switch, ↑↓ to scroll/select, Enter to drill in,
// Esc/Bksp to back up, 'e' to edit settings, ←→ to switch settings panes /
// log sources.

import readline from "readline";
import {
  buildProviderUsageWindowMap,
  clipPlainTail,
  correspondingLimitSettingKey,
  finiteNumber,
  fit,
  fmtDate,
  formatModelSettingDisplayValue,
  formatProviderSettingValue,
  formatProviderUsageHeader,
  formatProviderUsageWindow,
  getPrintableInput,
  getProviderUsageSettingHint,
  isBackspaceKey,
  isBooleanSettingValue,
  isEnterKey,
  loadIndexedReport,
  loadReportIndex,
  loadReports,
  matchesHotkey,
  normalizeNumericSettingValue,
  normalizeRawInput,
  parseJsonObject,
  parseProviderList,
  parseProviderUsageSettingKey,
  parseReportTimestamp,
  renderUsageBar,
  toDisplaySettingEntry,
  visibleLength,
} from "../../functions/admin/shared-helpers.js";
import {
  buildAdminGitDiffFileDetail,
  buildAdminGitDiffSnapshot,
} from "../../functions/admin/git-diff-review.js";
import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { purgeRuntimeLogs } from "../../functions/admin/purge-runtime-logs.js";
import { sanitizeWorkerExecArgv } from "../../../runtime/functions/worker-exec-argv.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { AdminSettingsController } from "./settings-controller.js";
import {
  normalizeAdminLine,
  sanitizeAdminStatusText,
  shortRunStartLabel,
  providerDashboardLabel,
  providerCostQualifier,
  providerDailyBudgetSettingKey,
  renderUsdUsageBar,
  safeGetSetting,
} from "./admin-tui-helpers.js";
import { buildAtlasReport, queryAtlasReportRows } from "./admin-atlas-report.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  listWorkItems,
  listJobs,
  findRunnableJobsBatch,
  findWriteLockConflict,
  getAgentCallStats,
  getScopeContextHealthMetrics,
  listActiveFileLocks,
  listWorkItemsWithCallRollups,
  getAgentCallsWithToolCountsByWorkItem,
  getAgentCallById,
  getToolInvocationsForAgentCall,
  getJob,
} from "../../../queue/functions/index.js";
import {
  getArtifactProtocols,
  getArtifactProtocol,
  getConfiguredImageModel,
  getConfiguredImageProviders,
  getResolvedImageProtocol,
} from "../../../artifacts/functions/index.js";
import { getConfiguredProviderUsage, inferProviderWindowLimit } from "../../../providers/functions/provider.js";
import { getRuntimeDbPath, getRuntimeLogDir, getRuntimeReportsDir } from "../../../runtime/functions/paths.js";
import { jobReportStatus, workItemDisplayStatus } from "../display/Display.js";
import { FAILED_JOB_STATUSES } from "../../../../catalog/job.js";
import { getAccountSettingsPathForDisplay } from "../../../settings/functions/account-settings.js";
import { closePromptLog, promptPreviewText, readRecentPrompts } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeOutputLog, readRecentOutputs } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { closeLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { buildCurrentRoleContract } from "../../../worker/functions/role-contract-view.js";
import { isAdminVisibleCatalogKey } from "../../../settings/functions/catalog.js";
import {
  loadSkillManifests,
  parseSkillIds,
  setSkillEnabled,
} from "../../../../shared/skills/functions/registry.js";
import {
  getCurrentRunProviderUsage,
  getLatestRunStartedAtIso,
  getTodayProviderUsage,
} from "../../functions/display/helpers/provider-usage.js";
import { roleBrandColor } from "../../functions/display/helpers/brand.js";
import { statusColor as paletteStatusColor } from "../../functions/display/status-palette.js";
import { fit as fitAnsi, stripAnsi } from "../../../../shared/format/functions/ansi.js";
import { formatConsoleArg } from "../../functions/display/helpers/formatters.js";
import {
  formatDuration as fmtDuration,
  formatRelativeTime as fmtRelativeTime,
  formatSignedTokens as fmtSignedTokens,
  formatTokens as fmtTokens,
  formatUsd as fmtUsd,
} from "../../../../shared/format/functions/units.js";
import {
  loadAtlasV2ProcessIndicators,
  renderAtlasV2ProcessIndicators,
} from "../../../atlas/functions/v2/process-indicators.js";
import {
  ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS,
  BOOLEAN_SETTING_KEYS,
  DEFAULT_ACCOUNT_SETTING_ROWS,
  DELEGATION_MODE_OPTIONS,
  ENUM_SETTING_OPTIONS,
  HIDDEN_SETTING_KEYS,
  NUMERIC_SETTING_RULES,
  PROVIDER_SETTING_KEYS,
  getAdminSettingPresentation,
  ATLAS_PHASE_OPTIONS,
  ATLAS_PHASE_SETTING_KEYS,
  ATLAS_PHASE_VALUES,
  SKILL_SETTING_PREFIX,
  SYNTHETIC_SETTING_KEYS,
  toDisplaySettingKey,
  toStorageSettingKey,
} from "../../../settings/functions/admin-catalog.js";

// Keep Settings on shortcut 1, but start on Overview so the first screen shows
// the operational agent/work summary instead of configuration controls.
const ADMIN_TABS = Object.freeze([
  Object.freeze({ id: "settings", name: "Settings" }),
  Object.freeze({ id: "overview", name: "Overview" }),
  Object.freeze({ id: "work_items", name: "Work Items" }),
  Object.freeze({ id: "diff_review", name: "Diff Review" }),
  Object.freeze({ id: "logs", name: "Logs" }),
  Object.freeze({ id: "atlas_report", name: "ATLAS Report" }),
]);
const ADMIN_TAB_COUNT = ADMIN_TABS.length;
const ADMIN_TAB_KEYS = new Set(ADMIN_TABS.map((_, index) => String(index + 1)));
const ADMIN_TAB_NAV_LABEL = `Tab/1-${ADMIN_TAB_COUNT}`;
const ADMIN_INITIAL_TAB_INDEX = Math.max(0, ADMIN_TABS.findIndex((tab) => tab.id === "overview"));
const ADMIN_LOG_SOURCES = Object.freeze([
  Object.freeze({ id: "prompts", label: "Prompts" }),
  Object.freeze({ id: "outputs", label: "Outputs" }),
]);
const SCIP_DEPENDENCY_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const SCIP_DEPENDENCY_ALERT_DISMISS_MS = 12_000;

export function canUseAdminTui({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return !!(
    stdin?.isTTY &&
    stdout?.isTTY &&
    typeof stdin?.setRawMode === "function"
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────


export { purgeRuntimeLogs };

// (Settings column-width helpers live in settings-controller.js, where the
// only consumer — _buildSettings — also lives.)

// ─── Report File Reader ─────────────────────────────────────────────────────

// ─── Admin TUI ──────────────────────────────────────────────────────────────

export class AdminTUI {
  constructor({ projectDir }) {
    this.projectDir = projectDir;
    this._tab = ADMIN_INITIAL_TAB_INDEX; // index into ADMIN_TABS — starts on Overview
    this._scroll = 0;
    this._tabScrolls = Array.from({ length: ADMIN_TAB_COUNT }, () => 0);
    this._logSource = "prompts"; // see ADMIN_LOG_SOURCES
    this._promptExpanded = -1;
    this._promptSelected = 0;
    this._promptCount = 0;
    this._promptRowMap = new Map();
    this._purgeLogsConfirm = false;
    this._purgeLogsMessage = "";
    this._done = null;
    this._editing = false;
    this._editKey = "";
    this._editLabel = "";
    this._editBuf = "";
    this._editCursor = 0;
    this._editStorageKey = "";
    this._editProviderChoices = [];
    this._editProviderIndex = 0;
    this._editPhaseChoices = [];
    this._editPhaseIndex = 0;
    this._editModelChoices = [];
    this._editModelIndex = 0;
    this._editBooleanChoices = [];
    this._editBooleanIndex = 0;
    this._editError = "";
    this._settingsIndex = 0;
    this._settingsPane = null;
    this._settingsRowMap = new Map();
    this._settingsSavedFlash = null;
    // Work Items tab state — three drill levels: list → WI detail → call detail.
    // _selectedWi / _selectedCall are DB ids (null = at that level's list).
    this._wiListIndex = 0;
    this._selectedWi = null;
    this._callListIndex = 0;
    this._selectedCall = null;
    this._wiRowMap = new Map();
    this._callRowMap = new Map();
    this._wiRowsCache = null;
    this._wiRowsCacheAt = 0;
    this._wiCallsCache = null;
    this._wiCallsCacheFor = null;
    this._wiCallsCacheAt = 0;
    this._diffFocus = "nav";
    this._diffListIndex = 0;
    this._diffNavScroll = 0;
    this._diffPaneScroll = 0;
    this._diffNavRowMap = new Map();
    this._diffSnapshotCache = null;
    this._diffSnapshotCacheAt = 0;
    this._diffSnapshotBuilding = false;
    this._diffDetailCache = null;
    this._diffDetailCacheKey = "";
    this._diffDetailCacheFileKey = "";
    this._diffDetailCacheAt = 0;
    this._diffDetailBuildingKey = null;
    this._lastInputSig = null;
    this._lastInputAt = 0;
    this._renderScheduled = false;
    this._renderTimer = null;
    this._lastRenderAt = 0;
    this._stdoutBackedUp = false;
    this._settingsCache = null;
    this._settingsCacheAt = 0;
    this._settingsController = new AdminSettingsController();
    this._lastExitAt = 0;
    this._consoleMessages = [];
    this._consoleInterceptState = null;
    this._consoleLogIntercept = null;
    this._consoleErrorIntercept = null;
    this._origConsoleLog = null;
    this._origConsoleError = null;
    this._scipDependencyInstall = null;
    this._scipDependencyWorker = null;
    this._scipDependencySpinnerTimer = null;
    this._scipDependencyDismissTimer = null;
    this._scipDependencyPendingStartTimer = null;
    this._scipDependencyRunId = 0;
    this._pendingScipDependencyInstallValue = null;
    this._signalHandlers = null;
    this._uncaughtExceptionHandler = null;
    this._onProcessExit = () => {
      if (!this._done) return;
      try { this._exitOnce(); } catch { /* best effort during process exit */ }
    };

    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 40;
  }

  _tabId() {
    return ADMIN_TABS[this._tab]?.id || ADMIN_TABS[0].id;
  }

  _buildCurrentRunUsageSection(width, providerUsage = null) {
    const runStartedAtIso = getLatestRunStartedAtIso();
    if (!runStartedAtIso) return [];
    const runUsage = getCurrentRunProviderUsage({ runStartedAtIso });
    if (!runUsage.length) return [];

    const inner = Math.max(16, width - 2);
    const summaries = Array.isArray(providerUsage) ? providerUsage : getConfiguredProviderUsage();
    const summaryByProvider = new Map(
      summaries
        .map((summary) => [String(summary?.provider || "").trim().toLowerCase(), summary])
        .filter(([provider]) => provider)
    );
    const todayByProvider = new Map(getTodayProviderUsage().map((entry) => [entry.provider, entry]));
    const lines = [];

    lines.push(` ${C.bold}Current Run Usage${C.reset}  ${C.dim}(since ${shortRunStartLabel(runStartedAtIso)})${C.reset}`);
    lines.push(` ${C.dim}${"-".repeat(Math.min(inner, 60))}${C.reset}`);

    for (const usage of runUsage) {
      const provider = String(usage.provider || "").trim().toLowerCase();
      const tokens = Number(usage.usedTokens) || 0;
      const input = Number(usage.usedInputTokens) || 0;
      const cachedInput = Math.min(input, Math.max(0, Number(usage.usedCachedInputTokens) || 0));
      const output = Number(usage.usedOutputTokens) || 0;
      const cost = Number(usage.costUsd) || 0;
      const tokenBreakdown = input > 0 || output > 0
        ? ` ${C.dim}(${fmtTokens(input)} in${cachedInput > 0 ? `, ${fmtTokens(cachedInput)} cached` : ""} + ${fmtTokens(output)} out)${C.reset}`
        : "";
      const costText = cost > 0
        ? `${fmtUsd(cost)} ${C.dim}${providerCostQualifier(provider)}${C.reset}`
        : `${C.dim}cost unavailable${C.reset}`;
      const callCount = Number(usage.callCount) || 0;
      const callText = callCount > 0 ? ` ${C.dim}${callCount} call${callCount === 1 ? "" : "s"}${C.reset}` : "";
      lines.push(fit(`  ${C.bold}${providerDashboardLabel(provider)}${C.reset}  ${fmtTokens(tokens)} tokens${tokenBreakdown}  ${costText}${callText}`, inner));

      if (provider === "claude") {
        const summary = summaryByProvider.get("claude");
        const windows = (summary?.windows || []).filter((window) => window.key === "session" || window.key === "week");
        for (const window of windows) {
          lines.push(fit(`   ${formatProviderUsageWindow(window)}`, inner));
        }
      }

      const budgetKey = providerDailyBudgetSettingKey(provider);
      if (budgetKey) {
        const budget = Number(safeGetSetting(budgetKey));
        if (Number.isFinite(budget) && budget > 0) {
          const todayCost = Number(todayByProvider.get(provider)?.costUsd) || 0;
          lines.push(fit(`   Today ${renderUsdUsageBar(todayCost, budget)}  ${fmtUsd(todayCost)} / ${fmtUsd(budget)} daily budget`, inner));
        }
      }
    }

    lines.push("");
    return lines;
  }

  renderSnapshot({ reason = null } = {}) {
    const allWIs = listWorkItems();
    const allJobs = listJobs();
    const reports = loadReportIndex(this.projectDir);
    const callStats = getAgentCallStats();
    const providerUsage = getConfiguredProviderUsage();
    const totalCalls = callStats.reduce((sum, stat) => sum + (stat.call_count || 0), 0);
    const totalInputTokens = callStats.reduce((sum, stat) => sum + (stat.total_input_tokens || 0), 0);
    const totalCachedInputTokens = callStats.reduce((sum, stat) => sum + (stat.total_cached_input_tokens || 0), 0);
    const totalOutputTokens = callStats.reduce((sum, stat) => sum + (stat.total_output_tokens || 0), 0);
    const totalDurationMs = callStats.reduce((sum, stat) => sum + (stat.total_duration_ms || 0), 0);
    const lockSnapshot = this._getAdminLockSnapshot();
    const imageProtocol = getResolvedImageProtocol();
    const providerSummary = this._getProviderSettingEntries()
      .map((entry) => `${entry.role}=${entry.setting_value || "claude"}`)
      .join(", ");
    const modelOverrides = this._getModelSettingEntries()
      .filter((entry) => entry.source === "global")
      .map((entry) => `${entry.setting_key}=${entry.setting_value}`)
      .slice(0, 6);

    const lines = [
      "POSSE ADMIN (non-interactive snapshot)",
      `Project: ${this.projectDir}`,
      `DB: ${getRuntimeDbPath(this.projectDir)}`,
    ];

    if (reason) lines.push(`Reason: ${reason}`);

    lines.push(
      "",
      "Overview",
      `- Work items: ${allWIs.length}`,
      `- Jobs: ${allJobs.length}`,
      `- Reports: ${reports.length}`,
      `- Agent calls: ${totalCalls}`,
      `- Tokens: ${fmtTokens(totalInputTokens + totalOutputTokens)} (${fmtTokens(totalInputTokens)} in${totalCachedInputTokens > 0 ? `, ${fmtTokens(totalCachedInputTokens)} cached` : ""} + ${fmtTokens(totalOutputTokens)} out)`,
      `- Agent runtime: ${fmtDuration(totalDurationMs)}`,
      "",
      "Locks",
      `- Waiting on locks: ${lockSnapshot.waiting.length}`,
      `- WI locks: ${lockSnapshot.wiLocks.length}`,
      `- Job locks: ${lockSnapshot.jobLocks.length}`,
      "",
      "Settings",
      `- Providers: ${providerSummary || "none"}`,
      `- Delegation mode: ${safeGetSetting("delegation_mode") || "js"}`,
      `- Auto-merge completed: ${safeGetSetting("auto_merge_completed") || "false"}`,
      `- Image route: ${imageProtocol?.provider || "unknown"}${imageProtocol?.model ? ` (${imageProtocol.model})` : ""}`,
    );

    if (modelOverrides.length > 0) {
      lines.push(`- Model overrides: ${modelOverrides.join(", ")}`);
    }

    const currentRunUsage = this._buildCurrentRunUsageSection(100, providerUsage);
    if (currentRunUsage.length > 0) {
      lines.push("", ...currentRunUsage.map((line) => stripAnsi(line).trimEnd()));
    }

    if (providerUsage.length > 0) {
      lines.push("", "Provider usage");
      for (const summary of providerUsage) {
        lines.push(`- ${stripAnsi(formatProviderUsageHeader(summary))}`);
        const windows = summary.windows || [];
        if (windows.length === 0) {
          lines.push("  no data");
          continue;
        }
        for (const window of windows) {
          lines.push(`  ${stripAnsi(formatProviderUsageWindow(window))}`);
        }
      }
    }

    lines.push("", "Tip: run `posse admin` in a fully interactive terminal for the live TUI.");
    return lines.join("\n");
  }

  renderSettingsSnapshot() {
    const entries = this._getEditableSettings();
    const lines = [
      "POSSE ADMIN SETTINGS",
      `Project: ${this.projectDir}`,
      "",
    ];

    for (const entry of entries) {
      const sourceDetail = entry.source === "env"
        ? `env${entry.db_value ? `, global=${entry.db_value}` : ""}`
        : entry.source || "default";
      const presentation = getAdminSettingPresentation(entry.setting_key, entry);
      lines.push(`${presentation.label} = ${entry.setting_value || ""}`);
      lines.push(`  Setting ID: ${entry.setting_key}`);
      if (presentation.description) lines.push(`  ${presentation.description}`);
      lines.push(`  source: ${sourceDetail}`);
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  run() {
    return new Promise((resolve) => {
      this._done = resolve;
      if (!this._settingsPane) this._settingsPane = "atlas";
      this._installConsoleIntercept();
      this._installExitHandlers();
      process.on("exit", this._onProcessExit);

      // Enter alternate screen, hide cursor, clear
      process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");

      // Raw mode stdin
      if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      this._keypressHandler = (str, key) => this._dispatchInput(str, key);
      process.stdin.on("keypress", this._keypressHandler);
      this._stdinDataHandler = (chunk) => {
        const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        if (raw.includes("\u0003")) {
          this._exitOnce();
        }
      };
      process.stdin.on("data", this._stdinDataHandler);

      this._resizeHandler = () => {
        this.cols = process.stdout.columns || 120;
        this.rows = process.stdout.rows || 40;
        process.stdout.write("\x1b[2J");
        this.requestRender({ force: true });
      };
      process.stdout.on("resize", this._resizeHandler);

      this.requestRender({ force: true });
    });
  }

  _exit() {
    const done = this._done;
    this._done = null;
    this._removeExitHandlers();
    if (this._keypressHandler) process.stdin.removeListener("keypress", this._keypressHandler);
    if (this._stdinDataHandler) process.stdin.removeListener("data", this._stdinDataHandler);
    if (this._resizeHandler) process.stdout.removeListener("resize", this._resizeHandler);
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._renderScheduled = false;
    this._stopScipDependencyInstallUi();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* terminal may already be closing */ }
      try { process.stdin.pause(); } catch { /* terminal may already be closing */ }
    }
    // Leave alternate screen, show cursor
    try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* stdout may already be closed */ }
    this._restoreConsoleIntercept();
    this._keypressHandler = null;
    this._resizeHandler = null;
    this._stdinDataHandler = null;
    if (done) done();
  }

  _exitOnce() {
    const now = Date.now();
    if (now - this._lastExitAt < 250) return;
    this._lastExitAt = now;
    this._exit();
  }

  _installExitHandlers() {
    if (this._signalHandlers || this._uncaughtExceptionHandler) return;
    this._signalHandlers = new Map();
    const signals = [
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ];
    for (const [signal, code] of signals) {
      const handler = () => {
        process.exitCode = code;
        this._exitOnce();
      };
      this._signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    this._uncaughtExceptionHandler = (err) => {
      const handler = this._uncaughtExceptionHandler;
      process.exitCode = 1;
      try {
        this._exitOnce();
      } catch {
        // Preserve the original uncaught exception.
      }
      if (handler) process.removeListener("uncaughtException", handler);
      throw err;
    };
    process.once("uncaughtException", this._uncaughtExceptionHandler);
  }

  _removeExitHandlers() {
    if (this._signalHandlers) {
      for (const [signal, handler] of this._signalHandlers.entries()) {
        process.removeListener(signal, handler);
      }
      this._signalHandlers = null;
    }
    if (this._uncaughtExceptionHandler) {
      process.removeListener("uncaughtException", this._uncaughtExceptionHandler);
      this._uncaughtExceptionHandler = null;
    }
    process.removeListener("exit", this._onProcessExit);
  }

  _installConsoleIntercept() {
    if (this._consoleInterceptState) return;
    this._origConsoleLog = console.log;
    this._origConsoleError = console.error;
    const consoleInterceptState = {
      active: true,
      log: this._origConsoleLog,
      error: this._origConsoleError,
    };
    this._consoleInterceptState = consoleInterceptState;
    const capture = (args, { error = false } = {}) => {
      const text = args.map(formatConsoleArg).join(" ").replace(/^\s+/, "");
      const line = error ? `${C.red}${text}${C.reset}` : text;
      this._consoleMessages.push(line);
      while (this._consoleMessages.length > 4) this._consoleMessages.shift();
      this.requestRender({ force: true });
    };
    this._consoleLogIntercept = (...args) => {
      if (!consoleInterceptState.active) {
        try { return consoleInterceptState.log?.(...args); } catch { return undefined; }
      }
      capture(args);
      return undefined;
    };
    this._consoleErrorIntercept = (...args) => {
      if (!consoleInterceptState.active) {
        try { return consoleInterceptState.error?.(...args); } catch { return undefined; }
      }
      capture(args, { error: true });
      try { consoleInterceptState.error?.(...args); } catch { /* preserve TUI even if stderr is closed */ }
      return undefined;
    };
    console.log = this._consoleLogIntercept;
    console.error = this._consoleErrorIntercept;
  }

  _restoreConsoleIntercept() {
    const origLog = this._origConsoleLog;
    const origError = this._origConsoleError;
    if (this._consoleInterceptState) this._consoleInterceptState.active = false;
    if (origLog && console.log === this._consoleLogIntercept) console.log = origLog;
    if (origError && console.error === this._consoleErrorIntercept) console.error = origError;
    this._consoleInterceptState = null;
    this._consoleLogIntercept = null;
    this._consoleErrorIntercept = null;
    this._origConsoleLog = null;
    this._origConsoleError = null;
  }

  _dispatchInput(str, key) {
    const keyName = key?.name || "";
    const sig = `${str || ""}|${keyName}|${key?.sequence || ""}|${key?.ctrl ? "ctrl" : ""}|${key?.shift ? "shift" : ""}`;
    const nowMs = Date.now();
    const isNavigation = keyName === "tab" || ADMIN_TAB_KEYS.has(String(str || keyName));
    const debounceMs = isNavigation ? 150 : 25;
    if (sig === this._lastInputSig && nowMs - this._lastInputAt < debounceMs) return;
    this._lastInputSig = sig;
    this._lastInputAt = nowMs;
    this._onKeypress(str, key);
  }

  requestRender({ force = false } = {}) {
    if (this._stdoutBackedUp) return;
    const now = Date.now();
    const minGap = force ? 16 : 100;
    const delay = Math.max(0, minGap - (now - this._lastRenderAt));
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._renderScheduled = false;
      if (this._stdoutBackedUp || !this._done) return;
      this._render();
    }, delay);
  }

  _runScipLanguageDependencyInstallAsync(value) {
    if (this._scipDependencyInstall?.active) {
      this._pendingScipDependencyInstallValue = value;
      const pendingLabel = this._formatScipDependencyLanguageLabel(value);
      this._scipDependencyInstall.pendingLabel = pendingLabel;
      this._scipDependencyInstall.message = `Current SCIP install is still running; queued ${pendingLabel}`;
      this.requestRender({ force: true });
      return;
    }

    this._clearScipDependencyDismissTimer();
    const runId = ++this._scipDependencyRunId;
    const languagesLabel = this._formatScipDependencyLanguageLabel(value);
    this._scipDependencyInstall = {
      active: true,
      runId,
      value,
      languagesLabel,
      pendingLabel: null,
      message: `Checking ${languagesLabel}`,
      events: [`checking ${languagesLabel}`],
      results: [],
      ok: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this._startScipDependencySpinner();
    this.requestRender({ force: true });

    let worker;
    try {
      worker = this._startScipLanguageDependencyWorker(value);
    } catch (err) {
      this._finishScipDependencyInstall(runId, {
        ok: false,
        message: `Could not start SCIP dependency installer: ${err?.message || err}`,
        results: [],
      });
      return;
    }

    this._scipDependencyWorker = worker;
    worker.on("message", (message) => {
      this._handleScipDependencyWorkerMessage(runId, message);
    });
    worker.on("error", (err) => {
      this._finishScipDependencyInstall(runId, {
        ok: false,
        message: `SCIP dependency installer failed: ${err?.message || err}`,
        results: [],
      });
    });
    worker.on("exit", (code) => {
      if (this._scipDependencyWorker === worker) {
        this._scipDependencyWorker = null;
      }
      if (code !== 0 && this._scipDependencyInstall?.runId === runId && this._scipDependencyInstall.active) {
        this._finishScipDependencyInstall(runId, {
          ok: false,
          message: `SCIP dependency installer exited with code ${code}`,
          results: [],
        });
      }
    });
  }

  _startScipLanguageDependencyWorker(value) {
    return new Worker(new URL("./scip-dependency-install-worker.js", import.meta.url), {
      execArgv: sanitizeWorkerExecArgv(),
      workerData: { languages: value },
    });
  }

  _formatScipDependencyLanguageLabel(value) {
    return sanitizeAdminStatusText(value) || "configured languages";
  }

  _handleScipDependencyWorkerMessage(runId, message) {
    if (this._scipDependencyInstall?.runId !== runId) return;
    if (message?.type === "progress") {
      this._updateScipDependencyProgress(message.message);
      return;
    }
    if (message?.type === "done") {
      this._finishScipDependencyInstall(runId, message.result || {
        ok: false,
        message: "SCIP dependency installer finished without a result",
        results: [],
      });
      return;
    }
    if (message?.type === "error") {
      this._finishScipDependencyInstall(runId, {
        ok: false,
        message: message.error || "SCIP dependency installer failed",
        results: [],
      });
    }
  }

  _updateScipDependencyProgress(message) {
    const state = this._scipDependencyInstall;
    if (!state) return;
    const text = sanitizeAdminStatusText(message);
    if (!text) return;
    state.message = text;
    state.events = [...(state.events || []), text].slice(-4);
    this.requestRender({ force: true });
  }

  _finishScipDependencyInstall(runId, result) {
    const state = this._scipDependencyInstall;
    if (!state || state.runId !== runId) return;
    const results = (Array.isArray(result?.results) ? result.results : [])
      .map((entry) => ({
        ...entry,
        language: sanitizeAdminStatusText(entry?.language),
        message: sanitizeAdminStatusText(entry?.message),
      }));
    const ok = result?.ok === true;
    this._stopScipDependencySpinner();
    state.active = false;
    state.ok = ok;
    state.finishedAt = Date.now();
    state.results = results;
    state.message = sanitizeAdminStatusText(result?.message) || (ok
      ? "SCIP dependency install completed"
      : "One or more SCIP dependency installers need attention");
    state.events = [
      ...(state.events || []),
      ...results.map((entry) => `${entry.language}: ${entry.message}`),
    ].slice(-4);

    const pendingValue = this._pendingScipDependencyInstallValue;
    this._pendingScipDependencyInstallValue = null;
    this.requestRender({ force: true });

    if (pendingValue != null && String(pendingValue) !== String(state.value)) {
      this._clearScipDependencyPendingStartTimer();
      this._scipDependencyPendingStartTimer = setTimeout(() => {
        this._scipDependencyPendingStartTimer = null;
        if (!this._done) return;
        this._runScipLanguageDependencyInstallAsync(pendingValue);
      }, 250);
      this._scipDependencyPendingStartTimer.unref?.();
      return;
    }

    this._scheduleScipDependencyAlertDismiss();
  }

  _startScipDependencySpinner() {
    this._stopScipDependencySpinner();
    this._scipDependencySpinnerTimer = setInterval(() => {
      this.requestRender({ force: true });
    }, 120);
    this._scipDependencySpinnerTimer.unref?.();
  }

  _stopScipDependencySpinner() {
    if (!this._scipDependencySpinnerTimer) return;
    clearInterval(this._scipDependencySpinnerTimer);
    this._scipDependencySpinnerTimer = null;
  }

  _scheduleScipDependencyAlertDismiss() {
    this._clearScipDependencyDismissTimer();
    this._scipDependencyDismissTimer = setTimeout(() => {
      if (this._scipDependencyInstall?.active) return;
      this._scipDependencyInstall = null;
      this.requestRender({ force: true });
    }, SCIP_DEPENDENCY_ALERT_DISMISS_MS);
    this._scipDependencyDismissTimer.unref?.();
  }

  _clearScipDependencyDismissTimer() {
    if (!this._scipDependencyDismissTimer) return;
    clearTimeout(this._scipDependencyDismissTimer);
    this._scipDependencyDismissTimer = null;
  }

  _clearScipDependencyPendingStartTimer() {
    if (!this._scipDependencyPendingStartTimer) return;
    clearTimeout(this._scipDependencyPendingStartTimer);
    this._scipDependencyPendingStartTimer = null;
  }

  _stopScipDependencyInstallUi() {
    this._stopScipDependencySpinner();
    this._clearScipDependencyDismissTimer();
    this._clearScipDependencyPendingStartTimer();
    if (this._scipDependencyWorker) {
      try { this._scipDependencyWorker.terminate(); } catch { /* best-effort shutdown */ }
      this._scipDependencyWorker = null;
    }
  }

  _onKeypress(str, key) {
    // Ctrl+C always exits
    if (key && key.ctrl && key.name === "c") {
      this._exitOnce();
      return;
    }

    const switchingTabsFromEdit = this._editing && key?.name === "tab";
    if (this._editing && !switchingTabsFromEdit) {
      this._onEditKeypress(str, key);
      return;
    }
    if (switchingTabsFromEdit) {
      this._resetEditState();
    }

    if (this._tabId() === "logs" && this._purgeLogsConfirm) {
      if (matchesHotkey(str, key, "y")) {
        try {
          const result = purgeRuntimeLogs({ projectDir: this.projectDir });
          this._purgeLogsMessage = `Purged ${result.files} file${result.files === 1 ? "" : "s"}${result.dirs ? ` and ${result.dirs} dir${result.dirs === 1 ? "" : "s"}` : ""}; cleared ${result.historyWorkItems || 0} historical WI${result.historyWorkItems === 1 ? "" : "s"}, ${result.dbAgentCalls || 0} call${result.dbAgentCalls === 1 ? "" : "s"}, ${result.dbObservations || 0} observation${result.dbObservations === 1 ? "" : "s"}, and ${result.dbEvents || 0} event${result.dbEvents === 1 ? "" : "s"}.`;
          this._promptExpanded = -1;
          this._promptSelected = 0;
          this._wiRowsCache = null;
          this._wiCallsCache = null;
          this._selectedWi = null;
          this._selectedCall = null;
          this._wiListIndex = 0;
          this._callListIndex = 0;
          this._scroll = 0;
        } catch (err) {
          this._purgeLogsMessage = `Purge failed: ${err?.message || err}`;
        }
        this._purgeLogsConfirm = false;
        this.requestRender({ force: true });
        return;
      }
      if (matchesHotkey(str, key, "n") || key?.name === "escape") {
        this._purgeLogsConfirm = false;
        this._purgeLogsMessage = "Log purge canceled.";
        this.requestRender({ force: true });
        return;
      }
    }

    const tabId = this._tabId();
    if (key && key.name === "escape") {
      if (tabId === "diff_review" && this._diffFocus === "diff") {
        this._diffFocus = "nav";
      } else if (tabId === "work_items" && this._selectedCall != null) {
        this._selectedCall = null;
        this._scroll = 0;
      } else if (tabId === "work_items" && this._selectedWi != null) {
        this._selectedWi = null;
        this._scroll = this._tabScrolls[this._tab];
      } else if (tabId === "logs" && this._promptExpanded >= 0) {
        this._promptExpanded = -1;
      } else {
        this._exit();
      }
    } else if (matchesHotkey(str, key, "q") && tabId !== "settings") {
      // On the settings tab printable keys (including q) fall through to the
      // type-to-edit fallback below instead of quitting.
      this._exit();
    } else if (isBackspaceKey(str, key) && tabId === "work_items" && this._selectedCall != null) {
      this._selectedCall = null;
      this._scroll = 0;
    } else if (isBackspaceKey(str, key) && tabId === "work_items" && this._selectedWi != null) {
      this._selectedWi = null;
      this._scroll = this._tabScrolls[this._tab];
    } else if (isEnterKey(str, key)) {
      if (tabId === "work_items" && this._selectedCall == null && this._selectedWi == null) {
        // Enter on WI list — open highlighted WI detail
        const rows = this._getWiRows();
        if (rows.length > 0) {
          this._wiListIndex = Math.max(0, Math.min(this._wiListIndex, rows.length - 1));
          this._selectedWi = rows[this._wiListIndex].id;
          this._callListIndex = 0;
          this._scroll = 0;
        }
      } else if (tabId === "work_items" && this._selectedWi != null && this._selectedCall == null) {
        // Enter on call list — open highlighted agent_call detail
        const calls = this._getWiCalls(this._selectedWi);
        if (calls.length > 0) {
          this._callListIndex = Math.max(0, Math.min(this._callListIndex, calls.length - 1));
          this._selectedCall = calls[this._callListIndex].id;
          this._scroll = 0;
        }
      } else if (tabId === "diff_review") {
        this._enterGitDiffPane();
      } else if (tabId === "settings") {
        this._startEdit();
        return;
      } else if (tabId === "logs") {
        if (this._promptExpanded >= 0) {
          this._promptExpanded = -1;
        } else {
          this._promptExpanded = Math.max(0, this._promptSelected || 0);
          this._scroll = 0;
        }
      }
    } else if (tabId === "diff_review" && matchesHotkey(str, key, "r")) {
      this._invalidateGitDiffReview();
    } else if (tabId === "diff_review" && (matchesHotkey(str, key, "j") || matchesHotkey(str, key, "k"))) {
      if (this._diffFocus === "diff") this._scrollGitDiffPane(matchesHotkey(str, key, "j") ? 1 : -1);
      else this._moveGitDiffSelection(matchesHotkey(str, key, "j") ? 1 : -1);
    } else if (tabId === "diff_review" && (
      matchesHotkey(str, key, "n")
      || matchesHotkey(str, key, "p")
      || str === "]"
      || str === "["
      || key?.name === "]"
      || key?.name === "["
    )) {
      const forward = matchesHotkey(str, key, "n") || str === "]" || key?.name === "]";
      this._jumpGitDiffHunk(forward ? 1 : -1);
    } else if (tabId === "logs" && (matchesHotkey(str, key, "j") || matchesHotkey(str, key, "k"))) {
      const delta = matchesHotkey(str, key, "j") ? 1 : -1;
      const maxPrompt = Math.max(0, Number(this._promptCount || 0) - 1);
      this._promptSelected = Math.min(maxPrompt, Math.max(0, (this._promptSelected || 0) + delta));
      if (this._promptExpanded >= 0) {
        this._promptExpanded = this._promptSelected;
        this._scroll = 0;
      } else {
        // Keep the > marker on screen — selection and scroll were previously
        // independent, letting j/k walk the cursor out of the viewport.
        this._scrollToMappedRow(this._promptRowMap.get(this._promptSelected));
        this._tabScrolls[this._tab] = this._scroll;
      }
    } else if (tabId === "logs" && matchesHotkey(str, key, "x")) {
      this._purgeLogsConfirm = true;
      this._purgeLogsMessage = "";
    } else if (tabId === "logs" && (key?.name === "left" || key?.name === "right")) {
      this._cycleLogSource(key.name === "right" ? 1 : -1);
    } else if (tabId === "diff_review" && key?.name === "right") {
      this._enterGitDiffPane();
    } else if (tabId === "diff_review" && key?.name === "left") {
      this._diffFocus = "nav";
    } else if (tabId === "settings" && (key?.name === "left" || key?.name === "right")) {
      this._cycleSettingsPane(key.name === "right" ? 1 : -1);
    } else if (key && key.name === "up") {
      if (tabId === "diff_review") {
        if (this._diffFocus === "diff") this._scrollGitDiffPane(-1);
        else this._moveGitDiffSelection(-1);
      } else if (tabId === "settings") {
        const selectedRow = this._settingsRowMap.get(this._getSelectedEditableSetting()?.setting_key);
        if (typeof selectedRow === "number" && this._scroll > selectedRow) {
          this._scroll--;
        } else {
          this._moveSettingsSelection(-1);
        }
      } else if (tabId === "work_items" && this._selectedCall == null && this._selectedWi == null) {
        const rows = this._getWiRows();
        if (rows.length > 0) {
          this._wiListIndex = Math.max(0, this._wiListIndex - 1);
          this._scrollToMappedRow(this._wiRowMap.get(this._wiListIndex));
        } else if (this._scroll > 0) {
          this._scroll--;
        }
      } else if (tabId === "work_items" && this._selectedWi != null && this._selectedCall == null) {
        const calls = this._getWiCalls(this._selectedWi);
        if (calls.length > 0) {
          this._callListIndex = Math.max(0, this._callListIndex - 1);
          this._scrollToMappedRow(this._callRowMap.get(this._callListIndex));
        } else if (this._scroll > 0) {
          this._scroll--;
        }
      } else if (this._scroll > 0) {
        this._scroll--;
      }
      this._tabScrolls[this._tab] = this._scroll;
    } else if (key && key.name === "down") {
      if (tabId === "diff_review") {
        if (this._diffFocus === "diff") this._scrollGitDiffPane(1);
        else this._moveGitDiffSelection(1);
      } else if (tabId === "settings") {
        const settingsList = this._getEditableSettings();
        if (settingsList.length > 0 && this._settingsIndex >= settingsList.length - 1) {
          this._scroll++;
        } else {
          this._moveSettingsSelection(1);
        }
      } else if (tabId === "work_items" && this._selectedCall == null && this._selectedWi == null) {
        const rows = this._getWiRows();
        if (rows.length > 0) {
          this._wiListIndex = Math.min(rows.length - 1, this._wiListIndex + 1);
          this._scrollToMappedRow(this._wiRowMap.get(this._wiListIndex));
        } else {
          this._scroll++;
        }
      } else if (tabId === "work_items" && this._selectedWi != null && this._selectedCall == null) {
        const calls = this._getWiCalls(this._selectedWi);
        if (calls.length > 0) {
          this._callListIndex = Math.min(calls.length - 1, this._callListIndex + 1);
          this._scrollToMappedRow(this._callRowMap.get(this._callListIndex));
        } else {
          this._scroll++;
        }
      } else {
        this._scroll++;
      }
      this._tabScrolls[this._tab] = this._scroll;
    } else if (tabId === "diff_review" && (key?.name === "pageup" || key?.name === "pagedown")) {
      const direction = key.name === "pagedown" ? 1 : -1;
      if (this._diffFocus === "diff") this._scrollGitDiffPane(direction * this._diffPanelRows());
      else this._moveGitDiffSelection(direction * Math.max(1, this._diffPanelRows() - 2));
    } else if (key && key.name === "tab") {
      this._resetEditState();
      this._selectedWi = null;
      this._selectedCall = null;
      this._purgeLogsConfirm = false;
      this._tab = key.shift
        ? (this._tab + ADMIN_TAB_COUNT - 1) % ADMIN_TAB_COUNT
        : (this._tab + 1) % ADMIN_TAB_COUNT;
      this._scroll = this._tabScrolls[this._tab];
      if (this._tabId() === "settings" && !this._settingsPane) this._settingsPane = "atlas";
    } else if (ADMIN_TAB_KEYS.has(String(str))) {
      this._resetEditState();
      this._selectedWi = null;
      this._selectedCall = null;
      this._purgeLogsConfirm = false;
      this._tab = parseInt(str) - 1;
      this._scroll = this._tabScrolls[this._tab];
      if (this._tabId() === "settings" && !this._settingsPane) this._settingsPane = "atlas";
    } else if (matchesHotkey(str, key, "e") && tabId === "settings") {
      this._startEdit();
      return;
    } else if (matchesHotkey(str, key, "m") && tabId === "settings") {
      this._cycleImageModel();
    } else if (tabId === "settings" && (key?.name === "pageup" || key?.name === "pagedown")) {
      this._jumpSettingsSection(key.name === "pagedown" ? 1 : -1);
      this.requestRender({ force: true });
      return;
    } else if (tabId === "settings" && !key?.ctrl && !key?.meta) {
      const printable = getPrintableInput(str, key);
      if (!printable) {
        this.requestRender({ force: true });
        return;
      }
      // Type-to-edit fallback for terminals where dedicated edit hotkeys behave oddly.
      this._startEdit(printable);
      return;
    }

    this.requestRender({ force: true });
  }

  _cycleLogSource(direction) {
    const sourceIds = ADMIN_LOG_SOURCES.map((source) => source.id);
    const currentIndex = sourceIds.indexOf(this._logSource);
    const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + direction + sourceIds.length) % sourceIds.length;
    this._logSource = sourceIds[nextIndex];
    this._promptSelected = 0;
    this._promptExpanded = -1;
    this._scroll = 0;
    this._tabScrolls[this._tab] = 0;
  }

  // ── Image Model Cycling ────────────────────────────────────────────────

  _cycleImageModel(...args) {
    return this._settingsController._cycleImageModel.call(this, ...args);
  }

  _jumpSettingsSection(...args) {
    return this._settingsController._jumpSettingsSection.call(this, ...args);
  }

  _cycleSettingsPane(...args) {
    return this._settingsController._cycleSettingsPane.call(this, ...args);
  }

  _invalidateSettingsCache(...args) {
    return this._settingsController._invalidateSettingsCache.call(this, ...args);
  }

  _getArtifactSettingEntries(...args) {
    return this._settingsController._getArtifactSettingEntries.call(this, ...args);
  }

  _getSkillSettingEntries(...args) {
    return this._settingsController._getSkillSettingEntries.call(this, ...args);
  }

  _getSettingsSnapshot(...args) {
    return this._settingsController._getSettingsSnapshot.call(this, ...args);
  }

  _getModelSettingEntries(...args) {
    return this._settingsController._getModelSettingEntries.call(this, ...args);
  }

  _getProviderUsageSettingEntries(...args) {
    return this._settingsController._getProviderUsageSettingEntries.call(this, ...args);
  }

  _getSelectableProviders(...args) {
    return this._settingsController._getSelectableProviders.call(this, ...args);
  }

  _normalizeProviderList(...args) {
    return this._settingsController._normalizeProviderList.call(this, ...args);
  }

  _getProviderSettingEntries(...args) {
    return this._settingsController._getProviderSettingEntries.call(this, ...args);
  }

  _getDelegationSettingEntries(...args) {
    return this._settingsController._getDelegationSettingEntries.call(this, ...args);
  }

  _getProjectDbSettingEntries(...args) {
    return this._settingsController._getProjectDbSettingEntries.call(this, ...args);
  }

  _getEditableSettings(...args) {
    return this._settingsController._getEditableSettings.call(this, ...args);
  }

  _getSelectedEditableSetting(...args) {
    return this._settingsController._getSelectedEditableSetting.call(this, ...args);
  }

  _moveSettingsSelection(...args) {
    return this._settingsController._moveSettingsSelection.call(this, ...args);
  }

  // ── Settings Edit Mode ────────────────────────────────────────────────

  _startEdit(...args) {
    return this._settingsController._startEdit.call(this, ...args);
  }

  _startProjectDbEdit(...args) {
    return this._settingsController._startProjectDbEdit.call(this, ...args);
  }

  _resetEditState(...args) {
    return this._settingsController._resetEditState.call(this, ...args);
  }

  _saveSettingValue(...args) {
    return this._settingsController._saveSettingValue.call(this, ...args);
  }

  _saveProjectDbSetting(...args) {
    return this._settingsController._saveProjectDbSetting.call(this, ...args);
  }

  _installScipLanguageDependencies(...args) {
    return this._settingsController._installScipLanguageDependencies.call(this, ...args);
  }

  _onEditKeypress(...args) {
    return this._settingsController._onEditKeypress.call(this, ...args);
  }

  _buildEditValueNavLines(...args) {
    return this._settingsController._buildEditValueNavLines.call(this, ...args);
  }

  _getEditValueCursorPosition(...args) {
    return this._settingsController._getEditValueCursorPosition.call(this, ...args);
  }

  _buildEditBooleanNavLines(...args) {
    return this._settingsController._buildEditBooleanNavLines.call(this, ...args);
  }

  _buildEditModelNavLines(...args) {
    return this._settingsController._buildEditModelNavLines.call(this, ...args);
  }

  _buildScipDependencyInstallNavLines() {
    const state = this._scipDependencyInstall;
    if (!state) return [];
    const active = state.active === true;
    const statusColor = active ? C.yellow : (state.ok ? C.green : C.red);
    const spinner = SCIP_DEPENDENCY_SPINNER_FRAMES[Math.floor(Date.now() / 120) % SCIP_DEPENDENCY_SPINNER_FRAMES.length];
    const elapsedMs = Math.max(0, (state.finishedAt || Date.now()) - (state.startedAt || Date.now()));
    const elapsed = elapsedMs >= 1000 ? ` ${C.dim}(${fmtDuration(elapsedMs)})${C.reset}` : "";
    const title = active
      ? `${spinner} Installing SCIP dependencies`
      : (state.ok ? "OK SCIP dependencies ready" : "!! SCIP dependency install needs attention");
    const lines = [
      ` ${statusColor}${title}${C.reset} ${C.dim}${state.languagesLabel || "configured languages"}${C.reset}${elapsed}`,
    ];
    if (state.message) {
      lines.push(`   ${C.dim}${state.message}${C.reset}`);
    }
    if (active && state.pendingLabel) {
      lines.push(`   ${C.yellow}Queued next selection:${C.reset} ${state.pendingLabel}`);
    }
    if (!active) {
      const results = Array.isArray(state.results) ? state.results.slice(-3) : [];
      for (const entry of results) {
        const marker = entry.ok ? `${C.green}ok${C.reset}` : `${C.yellow}warn${C.reset}`;
        lines.push(`   ${marker} ${entry.language}: ${entry.message}`);
      }
    }
    return lines;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  _render() {
    if (this._stdoutBackedUp) return;
    this._lastRenderAt = Date.now();
    const fullW = this.cols - 2;

    const builders = {
      settings: () => this._buildSettings(fullW),
      overview: () => this._buildOverview(fullW),
      work_items: () => this._buildWorkItemsTab(fullW),
      diff_review: () => this._buildGitDiffReview(fullW),
      logs: () => this._buildLogs(fullW),
      atlas_report: () => this._buildAtlasReport(fullW),
    };
    const tabId = this._tabId();
    const content = builders[tabId]().map(normalizeAdminLine);

    // Tab bar
    const tabBar = ADMIN_TABS.map((tab, i) => {
      const num = `${i + 1}`;
      if (i === this._tab) {
        return `${C.bold}${C.cyan}[${num}:${tab.name}]${C.reset}`;
      }
      return `${C.dim} ${num}:${tab.name} ${C.reset}`;
    }).join(" ");

    // Nav bar
    const navLines = [];
    if (this._editing === "editValue") {
      navLines.push(...this._buildEditValueNavLines(fullW));
    } else if (this._editing === "editModel") {
      navLines.push(...this._buildEditModelNavLines());
    } else if (this._editing === "editBoolean") {
      navLines.push(...this._buildEditBooleanNavLines());
    } else if (this._editing === "editProviders") {
      const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
      const toggles = this._editProviderChoices.map((choice, index) => {
        const marker = choice.enabled ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
        const label = `${index + 1}:${choice.label || choice.provider}`;
        if (index === this._editProviderIndex) return `${C.yellow}>${marker} ${label}<${C.reset}`;
        return `${marker} ${label}`;
      }).join(` ${C.dim}|${C.reset} `);
      navLines.push(` ${C.yellow}Editing ${editLabel}:${C.reset} ${toggles}`);
      navLines.push(` ${C.dim}[←→/↑↓] Move  [Space] Toggle  [1-4/c-o-x-g] Jump/Toggle  [Enter] Save  [Esc] Cancel${C.reset}`);
    } else if (this._editing === "editPhases") {
      const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
      const toggles = this._editPhaseChoices.map((choice, index) => {
        const marker = choice.enabled ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
        const label = `${index + 1}:${choice.label}`;
        if (index === this._editPhaseIndex) return `${C.yellow}>${marker} ${label}<${C.reset}`;
        return `${marker} ${label}`;
      }).join(` ${C.dim}|${C.reset} `);
      navLines.push(` ${C.yellow}Editing ${editLabel}:${C.reset} ${toggles}`);
      navLines.push(` ${C.dim}[←→/↑↓] Move  [Space] Toggle  [1-9] Jump  [Enter] Save  [Esc] Cancel${C.reset}`);
      if (this._editError) navLines.push(` ${C.red}${this._editError}${C.reset}`);
    } else if (this._editing === "editSkills") {
      // Vertical checkbox list scrolling around the cursor — skills can be many.
      const choices = this._editSkillChoices || [];
      const cursor = Math.max(0, Math.min(this._editSkillIndex || 0, choices.length - 1));
      const visible = Math.min(10, Math.max(3, this.rows - 12));
      const start = Math.max(0, Math.min(choices.length - visible, cursor - Math.floor(visible / 2)));
      const disabledCount = choices.filter((c) => c.disabled).length;
      navLines.push(` ${C.yellow}Disabled skills${C.reset} ${C.dim}(${disabledCount}/${choices.length} disabled)${C.reset}`);
      for (let i = start; i < Math.min(choices.length, start + visible); i++) {
        const c = choices[i];
        const marker = c.disabled ? `${C.red}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
        const pointer = i === cursor ? `${C.yellow}>${C.reset}` : " ";
        const name = i === cursor ? `${C.bold}${c.name}${C.reset}` : c.name;
        navLines.push(` ${pointer} ${marker} ${C.dim}${String(i + 1).padStart(2)}${C.reset} ${name}  ${C.dim}${c.id}${C.reset}`);
      }
      if (start + visible < choices.length) {
        navLines.push(` ${C.dim}… ${choices.length - (start + visible)} more below${C.reset}`);
      }
      navLines.push(` ${C.dim}[↑↓] Move  [Space] Toggle  [PgUp/PgDn] Page  [Home/End] Jump  [Enter] Save  [Esc] Cancel${C.reset}`);
    } else if (tabId === "work_items" && this._selectedCall != null) {
      navLines.push(` ${C.dim}[Esc/Bksp] Back to WI  [\u2191\u2193] Scroll  [${ADMIN_TAB_NAV_LABEL}] Section${C.reset}`);
    } else if (tabId === "work_items" && this._selectedWi != null) {
      navLines.push(` ${C.dim}[↑↓] Select call  [Enter] Open call  [Esc/Bksp] Back to list  [${ADMIN_TAB_NAV_LABEL}] Section${C.reset}`);
    } else if (tabId === "work_items") {
      navLines.push(` ${C.dim}[↑↓] Select WI  [Enter] Open WI  [${ADMIN_TAB_NAV_LABEL}] Section  [q/Esc] Exit${C.reset}`);
    } else if (tabId === "diff_review") {
      if (this._diffFocus === "diff") {
        navLines.push(` ${C.dim}[↑↓/PgUp/PgDn] Scroll diff  [n/p] Hunk  [←/Esc] Files  [r] Refresh  [${ADMIN_TAB_NAV_LABEL}] Section${C.reset}`);
      } else {
        navLines.push(` ${C.dim}[↑↓] Select file  [→/Enter] Diff pane  [PgUp/PgDn] Page files  [r] Refresh  [${ADMIN_TAB_NAV_LABEL}] Section  [q/Esc] Exit${C.reset}`);
      }
    } else if (tabId === "settings") {
      const selected = this._getSelectedEditableSetting();
      navLines.push(` ${C.dim}[←→] Pane  [↑↓] Select  [PgUp/PgDn] Jump section  [Enter/e/type] Edit highlighted item  [${ADMIN_TAB_NAV_LABEL}] Section  [Esc] Exit${C.reset}`);
      if (selected) navLines.push(` ${C.dim}Selected:${C.reset} ${C.bold}${selected.setting_key}${C.reset} ${C.dim}${selected.description || ""}${C.reset}`);
      if (this._settingsSavedFlash && (Date.now() - (this._settingsSavedFlash.at || 0)) < 3_000) {
        navLines.push(` ${C.green}✓ ${this._settingsSavedFlash.text}${C.reset}`);
      }
    } else if (tabId === "atlas_report") {
      navLines.push(` ${C.dim}[↑↓] Scroll  [${ADMIN_TAB_NAV_LABEL}] Section  [q/Esc] Exit${C.reset}`);
    } else if (tabId === "logs") {
      const expanded = this._promptExpanded >= 0;
      if (this._purgeLogsConfirm) {
        navLines.push(` ${C.red}Purge runtime logs, DB history, and ATLAS telemetry?${C.reset} ${C.dim}[y] Confirm  [n/Esc] Cancel${C.reset}`);
      } else {
        navLines.push(` ${C.dim}[\u2190\u2192] Log source  [\u2191\u2193] Scroll  [Enter] ${expanded ? "Collapse" : "Expand selected"}  [j/k] Prev/Next  [x] Purge logs+DB history+ATLAS telemetry  [${ADMIN_TAB_NAV_LABEL}] Section  [Esc] ${expanded ? "Collapse" : "Exit"}${C.reset}`);
      }
    } else {
      navLines.push(` ${C.dim}[${ADMIN_TAB_NAV_LABEL}] Section  [\u2191\u2193] Scroll  [q/Esc] Exit${C.reset}`);
    }
    navLines.push(...this._buildScipDependencyInstallNavLines());
    if (this._consoleMessages.length > 0) {
      for (const message of this._consoleMessages.slice(-2)) {
        navLines.push(` ${C.dim}Console:${C.reset} ${message}`);
      }
    }

    const frameRows = navLines.length + 5; // top border + title + divider + nav divider + bottom border
    const mainRows = Math.max(this.rows - frameRows, 5);
    const requestedScroll = Number(this._scroll);
    const maxScroll = Math.max(0, content.length - mainRows);
    this._scroll = Math.min(
      Number.isFinite(requestedScroll) ? Math.max(0, Math.floor(requestedScroll)) : 0,
      maxScroll,
    );
    this._tabScrolls[this._tab] = this._scroll;
    const scrolled = content.slice(this._scroll);
    const displayContent = [];
    for (let i = 0; i < mainRows; i++) {
      displayContent.push(i < scrolled.length ? scrolled[i] : "");
    }

    // Build frame
    let buf = "";
    let row = 1;

    buf += `\x1b[${row};1H${C.dim}\u250c${"\u2500".repeat(fullW)}\u2510${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(` ${C.bold}POSSE ADMIN${C.reset}  ${tabBar}`, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(fullW)}\u2524${C.reset}\x1b[K`;
    row++;

    for (let i = 0; i < mainRows; i++) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(displayContent[i], fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(fullW)}\u2524${C.reset}\x1b[K`;
    row++;

    const navStartRow = row;
    for (const line of navLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    buf += `\x1b[${row};1H${C.dim}\u2514${"\u2500".repeat(fullW)}\u2518${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H\x1b[J`;

    if (this._editing === "editValue") {
      const cursor = this._getEditValueCursorPosition(fullW, navStartRow);
      buf += `\x1b[${cursor.row};${cursor.col}H`;
    }

    const ok = process.stdout.write(buf);
    if (!ok) {
      this._stdoutBackedUp = true;
      process.stdout.once("drain", () => {
        this._stdoutBackedUp = false;
        this.requestRender({ force: true });
      });
    }
  }

  _getAdminLockSnapshot({ maxCandidates = 200 } = {}) {
    let activeLocks = { work_items: [], jobs: [] };
    try {
      activeLocks = listActiveFileLocks();
    } catch {
      activeLocks = { work_items: [], jobs: [] };
    }

    let workItems = [];
    let jobs = [];
    try { workItems = listWorkItems(); } catch { workItems = []; }
    try { jobs = listJobs(); } catch { jobs = []; }
    const wiById = new Map(workItems.map((wi) => [Number(wi.id), wi]));
    const jobById = new Map(jobs.map((job) => [Number(job.id), job]));

    let candidates = [];
    try {
      const excludeJobIds = new Set();
      while (candidates.length < maxCandidates) {
        const limit = Math.min(50, maxCandidates - candidates.length);
        const batch = findRunnableJobsBatch(limit, { excludeJobIds: [...excludeJobIds] });
        if (!batch.length) break;
        for (const job of batch) {
          excludeJobIds.add(job.id);
          candidates.push(job);
        }
        if (batch.length < limit) break;
      }
    } catch {
      candidates = jobs.filter((job) => job.status === "queued").slice(0, maxCandidates);
    }

    const waiting = [];
    for (const job of candidates) {
      let conflict = null;
      try { conflict = findWriteLockConflict(job); } catch { conflict = null; }
      if (!conflict) continue;
      waiting.push(this._describeAdminLockWait(job, conflict, wiById, jobById));
    }

    return {
      waiting,
      wiLocks: Array.isArray(activeLocks?.work_items) ? activeLocks.work_items : [],
      jobLocks: Array.isArray(activeLocks?.jobs) ? activeLocks.jobs : [],
      wiById,
      jobById,
    };
  }

  _describeAdminLockWait(job, conflict, wiById, jobById) {
    const lock = conflict?.lock || {};
    const candidate = conflict?.candidate || {};
    const waitingWi = wiById.get(Number(job.work_item_id));
    const scopePath = candidate.path || lock.path || "unknown";
    const scopeKind = candidate.lock_kind || lock.lock_kind || "lock";
    const waiting = {
      jobId: job.id,
      workItemId: job.work_item_id,
      jobType: job.job_type || "?",
      title: job.title || "",
      wiTitle: waitingWi?.title || "",
      scope: `${scopeKind} ${scopePath}`,
    };

    if (conflict?.type === "work_item") {
      const holderId = lock.work_item_id;
      const holderWi = wiById.get(Number(holderId));
      const status = [holderWi?.status || lock.work_item_status, holderWi?.merge_state || lock.merge_state]
        .filter(Boolean)
        .join("/");
      return {
        waiting,
        holder: {
          type: "WI",
          id: holderId,
          label: `WI#${holderId ?? "?"}`,
          detail: [status, holderWi?.title || lock.work_item_title].filter(Boolean).join("  "),
          path: lock.path || scopePath,
          source: lock.source_job_id != null ? `source job #${lock.source_job_id}` : "",
        },
      };
    }

    const holderJobId = lock.job_id;
    const holderJob = jobById.get(Number(holderJobId));
    const holderWi = wiById.get(Number(lock.work_item_id ?? holderJob?.work_item_id));
    const status = [holderJob?.job_type || lock.job_type, holderJob?.status || lock.job_status]
      .filter(Boolean)
      .join("/");
    const wiLabel = lock.work_item_id != null || holderJob?.work_item_id != null
      ? ` WI#${lock.work_item_id ?? holderJob?.work_item_id}`
      : "";
    return {
      waiting,
      holder: {
        type: "job",
        id: holderJobId,
        label: `job #${holderJobId ?? "?"}${wiLabel}`,
        detail: [status, holderJob?.title || lock.job_title, holderWi?.title].filter(Boolean).join("  "),
        path: lock.path || scopePath,
        source: "",
      },
    };
  }

  // ── Tab 1: Overview ───────────────────────────────────────────────────

  _buildOverview(width) {
    const lines = [];
    const inner = width - 2;
    const db = getDb();

    lines.push("");
    lines.push(` ${C.bold}${C.cyan}\u2550\u2550\u2550 ALL-TIME STATISTICS \u2550\u2550\u2550${C.reset}`);
    lines.push("");

    // ── Work Items Summary ──
    const allWIs = listWorkItems();
    const allJobs = listJobs();
    const jobsByWi = new Map();
    for (const job of allJobs) {
      if (!jobsByWi.has(job.work_item_id)) jobsByWi.set(job.work_item_id, []);
      jobsByWi.get(job.work_item_id).push(job);
    }
    const wiByStatus = {};
    for (const wi of allWIs) {
      const displayStatus = workItemDisplayStatus(wi, jobsByWi.get(wi.id) || []);
      wiByStatus[displayStatus] = (wiByStatus[displayStatus] || 0) + 1;
    }
    lines.push(` ${C.bold}Work Items${C.reset}  ${C.dim}(${allWIs.length} total)${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
    const wiStatuses = ["complete", "running", "planned", "queued", "failed", "canceled"];
    const wiLine = wiStatuses
      .filter(s => wiByStatus[s])
      .map(s => {
        const c = s === "complete" ? C.green : s === "failed" || s === "canceled" ? C.red : s === "running" ? C.yellow : s === "queued" ? C.blue : C.dim;
        return `${c}${wiByStatus[s]} ${s}${C.reset}`;
      }).join("  ");
    lines.push(` ${wiLine || `${C.dim}none${C.reset}`}`);
    lines.push("");

    // ── Jobs Summary ──
    const jobByStatus = {};
    const jobByType = {};
    for (const j of allJobs) {
      const displayStatus = jobReportStatus(j, allJobs);
      jobByStatus[displayStatus] = (jobByStatus[displayStatus] || 0) + 1;
      jobByType[j.job_type] = (jobByType[j.job_type] || 0) + 1;
    }
    lines.push(` ${C.bold}Jobs${C.reset}  ${C.dim}(${allJobs.length} total)${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);

    // By status
    const jStatuses = ["succeeded", "recovered", ...FAILED_JOB_STATUSES, "running", "leased", "queued", "canceled"];
    const jLine = jStatuses
      .filter(s => jobByStatus[s])
      .map(s => {
        const c = s === "succeeded" ? C.green : s === "recovered" ? C.yellow : FAILED_JOB_STATUSES.includes(s) ? C.red : s === "running" ? C.yellow : s === "leased" || s === "queued" ? C.blue : C.dim;
        return `${c}${jobByStatus[s]} ${s}${C.reset}`;
      }).join("  ");
    lines.push(` ${jLine || `${C.dim}none${C.reset}`}`);

    // By type
    const typeColors = { research: C.magenta, plan: C.cyan, dev: C.green, fix: C.yellow, assess: C.yellow };
    const typeLine = Object.entries(jobByType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${typeColors[t] || C.dim}${n} ${t}${C.reset}`)
      .join("  ");
    lines.push(` ${C.dim}By type:${C.reset} ${typeLine}`);
    lines.push("");

    try {
      const indicators = loadAtlasV2ProcessIndicators({ projectDir: this.projectDir, limit: 4 });
      lines.push(...renderAtlasV2ProcessIndicators(indicators, { colors: C, width: Math.max(60, inner), compact: true }));
      lines.push("");
    } catch {
      // Keep the overview usable if ATLAS v2 DBs are absent or mid-migration.
    }

    // ── Agent Calls / Token Summary ──
    const callStats = getAgentCallStats();
    const providerUsage = getConfiguredProviderUsage();
    let totalCalls = 0, totalSucceeded = 0, totalFailed = 0;
    let totalInTok = 0, totalCachedInTok = 0, totalOutTok = 0, totalDurMs = 0;

    for (const s of callStats) {
      totalCalls += s.call_count;
      totalSucceeded += s.succeeded;
      totalFailed += s.failed;
      totalInTok += (s.total_input_tokens || 0);
      totalCachedInTok += (s.total_cached_input_tokens || 0);
      totalOutTok += (s.total_output_tokens || 0);
      totalDurMs += (s.total_duration_ms || 0);
    }

    const totalTok = totalInTok + totalOutTok;

    lines.push(` ${C.bold}Token Usage${C.reset}  ${C.dim}(all time)${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
    lines.push(` ${C.bold}\u250c${"─".repeat(Math.min(inner - 4, 66))}\u2510${C.reset}`);
    lines.push(` ${C.bold}\u2502${C.reset}  ${C.bold}Total Tokens:${C.reset}    ${fmtTokens(totalTok)}  ${C.dim}(${fmtTokens(totalInTok)} in${totalCachedInTok > 0 ? `, ${fmtTokens(totalCachedInTok)} cached` : ""} + ${fmtTokens(totalOutTok)} out)${C.reset}`);
    lines.push(` ${C.bold}\u2502${C.reset}  ${C.bold}Total Duration:${C.reset}  ${fmtDuration(totalDurMs)}`);
    lines.push(` ${C.bold}\u2502${C.reset}  ${C.bold}Agent Calls:${C.reset}     ${totalCalls}  ${C.green}${totalSucceeded} ok${C.reset}${totalFailed > 0 ? `  ${C.red}${totalFailed} failed${C.reset}` : ""}`);
    if (totalCalls > 0) {
      lines.push(` ${C.bold}\u2502${C.reset}  ${C.bold}Success Rate:${C.reset}    ${C.green}${(100 * totalSucceeded / totalCalls).toFixed(1)}%${C.reset}`);
      lines.push(` ${C.bold}\u2502${C.reset}  ${C.bold}Avg per Call:${C.reset}    ${fmtTokens(Math.round(totalTok / totalCalls))} tokens  ${fmtDuration(Math.round(totalDurMs / totalCalls))}`);
    }
    lines.push(` ${C.bold}\u2514${"─".repeat(Math.min(inner - 4, 66))}\u2518${C.reset}`);
    lines.push("");

    try {
      const sessionSummary = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_lanes,
          COUNT(*) AS total_lanes
        FROM session_lanes
      `).get();
      const savingsSummary = db.prepare(`
        SELECT
          COUNT(*) AS samples,
          COALESCE(SUM(tokens_saved), 0) AS tokens_saved
        FROM session_recycle_savings
      `).get();
      if ((sessionSummary?.total_lanes || 0) > 0 || (savingsSummary?.samples || 0) > 0) {
        lines.push(` ${C.bold}Session Recycling${C.reset}`);
        lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
        lines.push(
          `  ${C.dim}Lanes:${C.reset} ${sessionSummary?.active_lanes || 0} active / ${sessionSummary?.total_lanes || 0} total  ` +
          `${C.dim}Savings:${C.reset} ${fmtSignedTokens(savingsSummary?.tokens_saved || 0)} tokens across ${savingsSummary?.samples || 0} resumed call(s)`
        );
        lines.push("");
      }
    } catch {
      // Older DBs or transient migrations may not have session tables yet.
    }

    lines.push(...this._buildCurrentRunUsageSection(width, providerUsage));

    if (providerUsage.length > 0) {
      lines.push(` ${C.bold}Provider Limits${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      for (const summary of providerUsage) {
        lines.push(`  ${C.bold}${formatProviderUsageHeader(summary)}${C.reset}`);
        for (const window of summary.windows || []) {
          lines.push(`   ${formatProviderUsageWindow(window)}`);
        }
      }
      lines.push("");
    }

    // ── Model Breakdown ──
    const scopeMetrics = getScopeContextHealthMetrics({ trailingDays: 7 });
    const allTimeSignals = scopeMetrics.all_time || {};
    const trailingSignals = scopeMetrics.trailing || {};
    const trailingDays = Number(scopeMetrics.trailing_days || 7);
    const dropDenominator = Math.max(1, Number(allTimeSignals.under_scoped_drops || 0));
    const recoveryRatePct = Math.round((100 * Number(allTimeSignals.recovery_escalations || 0)) / dropDenominator);
    lines.push(` ${C.bold}Scope/Context Hygiene${C.reset}  ${C.dim}(event-derived)${C.reset}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.min(inner, 60))}${C.reset}`);
    lines.push(
      `  ${C.dim}All time:${C.reset} ` +
      `${C.yellow}${allTimeSignals.under_scoped_drops || 0} under-scoped drops${C.reset}  ` +
      `${C.cyan}${allTimeSignals.recovery_escalations || 0} recovery escalations${C.reset}  ` +
      `${C.magenta}${allTimeSignals.scope_cleaned_noops || 0} scope-cleaned noops${C.reset}`
    );
    lines.push(
      `  ${C.dim}Trailing ${trailingDays}d:${C.reset} ` +
      `${trailingSignals.under_scoped_drops || 0} drops  ` +
      `${trailingSignals.recovery_escalations || 0} escalations  ` +
      `${trailingSignals.scope_cleaned_noops || 0} scope-cleaned`
    );
    lines.push(
      `  ${C.dim}Scheduler shadow:${C.reset} ` +
      `${allTimeSignals.strict_shadow_conflicts || 0} all-time  ` +
      `${trailingSignals.strict_shadow_conflicts || 0} trailing ${trailingDays}d`
    );
    lines.push(
      `  ${C.dim}Context trimmed packets:${C.reset} ` +
      `${allTimeSignals.context_trimmed_packets || 0} all-time  ` +
      `${trailingSignals.context_trimmed_packets || 0} trailing ${trailingDays}d`
    );
    lines.push(`  ${C.dim}Recovery ratio (all-time): ${recoveryRatePct}% escalations / under-scoped drops${C.reset}`);
    lines.push("");

    const modelMap = new Map();
    // Query agent_calls directly for model-level breakdown
    try {
      const rows = db.prepare(`
        SELECT COALESCE(model_name, model_tier, 'unknown') as model,
               COUNT(*) as calls,
               SUM(input_tokens) as input_tokens,
               SUM(cached_input_tokens) as cached_input_tokens,
               SUM(output_tokens) as output_tokens,
               SUM(duration_ms) as duration_ms,
               SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded
        FROM agent_calls GROUP BY model ORDER BY calls DESC
      `).all();
      for (const r of rows) modelMap.set(r.model, r);
    } catch { /* ignore */ }

    if (modelMap.size > 0) {
      lines.push(` ${C.bold}Model Usage${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      const hdr = `  ${"Model".padEnd(20)} ${"Calls".padStart(7)} ${"Tokens".padStart(10)} ${"Cached".padStart(9)} ${"Duration".padStart(10)} ${"Success".padStart(8)}`;
      lines.push(` ${C.dim}${hdr}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdr.length + 2, inner))}${C.reset}`);

      for (const [model, m] of modelMap) {
        const tok = (m.input_tokens || 0) + (m.output_tokens || 0);
        const rate = m.calls > 0 ? `${Math.round(100 * m.succeeded / m.calls)}%` : "—";
        lines.push(
          `  ${C.bold}${model.padEnd(20)}${C.reset} ` +
          `${String(m.calls).padStart(7)} ` +
          `${fmtTokens(tok).padStart(10)} ` +
          `${fmtTokens(m.cached_input_tokens || 0).padStart(9)} ` +
          `${fmtDuration(m.duration_ms).padStart(10)} ` +
          `${(m.succeeded === m.calls ? C.green : C.yellow)}${rate.padStart(8)}${C.reset}`
        );
      }
      lines.push("");
    }

    // ── Role Breakdown ──
    if (callStats.length > 0) {
      lines.push(` ${C.bold}Role Breakdown${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);

      const roleAgg = new Map();
      for (const s of callStats) {
        if (!roleAgg.has(s.role)) roleAgg.set(s.role, { calls: 0, inTok: 0, cachedInTok: 0, outTok: 0, dur: 0, ok: 0, fail: 0 });
        const r = roleAgg.get(s.role);
        r.calls += s.call_count;
        r.inTok += (s.total_input_tokens || 0);
        r.cachedInTok += (s.total_cached_input_tokens || 0);
        r.outTok += (s.total_output_tokens || 0);
        r.dur += (s.total_duration_ms || 0);
        r.ok += s.succeeded;
        r.fail += s.failed;
      }

      const hdr2 = `  ${"Role".padEnd(14)} ${"Calls".padStart(7)} ${"In Tok".padStart(9)} ${"Cached".padStart(9)} ${"Out Tok".padStart(9)} ${"Duration".padStart(10)} ${"% Share".padStart(8)}`;
      lines.push(` ${C.dim}${hdr2}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdr2.length + 2, inner))}${C.reset}`);

      for (const [role, r] of roleAgg) {
        const color = roleBrandColor(role);
        const tok = r.inTok + r.outTok;
        const pct = totalTok > 0 ? `${Math.round(100 * tok / totalTok)}%` : "—";
        lines.push(
          `  ${color}${role.padEnd(14)}${C.reset} ` +
          `${String(r.calls).padStart(7)} ` +
          `${fmtTokens(r.inTok).padStart(9)} ` +
          `${fmtTokens(r.cachedInTok).padStart(9)} ` +
          `${fmtTokens(r.outTok).padStart(9)} ` +
          `${fmtDuration(r.dur).padStart(10)} ` +
          `${pct.padStart(8)}`
        );
      }
      lines.push("");
    }

    return lines;
  }

  // ── Tab 1: Work Items ────────────────────────────────

  _getWiRows() {
    if (this._wiRowsCache && (Date.now() - this._wiRowsCacheAt) < 2000) return this._wiRowsCache;
    try { this._wiRowsCache = listWorkItemsWithCallRollups({ limit: 200 }); }
    catch { this._wiRowsCache = []; }
    this._wiRowsCacheAt = Date.now();
    return this._wiRowsCache;
  }

  _getWiCalls(wiId) {
    if (this._wiCallsCache && this._wiCallsCacheFor === wiId && (Date.now() - this._wiCallsCacheAt) < 2000) {
      return this._wiCallsCache;
    }
    try { this._wiCallsCache = getAgentCallsWithToolCountsByWorkItem(wiId); }
    catch { this._wiCallsCache = []; }
    this._wiCallsCacheFor = wiId;
    this._wiCallsCacheAt = Date.now();
    return this._wiCallsCache;
  }

  _scrollToMappedRow(row) {
    if (typeof row !== "number") return;
    const visibleRows = Math.max(this.rows - 6, 5);
    if (row < this._scroll) this._scroll = row;
    else if (row >= this._scroll + visibleRows) this._scroll = Math.max(0, row - visibleRows + 1);
  }

  _diffPanelRows() {
    return Math.max(8, this.rows - 11);
  }

  _invalidateGitDiffReview() {
    this._diffSnapshotCache = null;
    this._diffSnapshotCacheAt = 0;
    this._diffDetailCache = null;
    this._diffDetailCacheKey = "";
    this._diffDetailCacheFileKey = "";
    this._diffDetailCacheAt = 0;
    this._diffDetailBuildingKey = null;
    this._diffPaneScroll = 0;
  }

  // The git diff snapshot fans out many git spawns; building it inline would
  // freeze the keypress/render thread. Instead this returns the cached snapshot
  // synchronously (or a "loading" placeholder on first paint) and kicks off the
  // build in the background, re-rendering when it lands. A stale-but-present
  // cache keeps showing while a refresh runs, so there is no flash to "loading".
  _getGitDiffSnapshot() {
    const fresh = this._diffSnapshotCache && (Date.now() - this._diffSnapshotCacheAt) < 3000;
    if (!fresh) this._startGitDiffSnapshotBuild();
    return this._diffSnapshotCache || this._gitDiffPlaceholderSnapshot();
  }

  _gitDiffPlaceholderSnapshot() {
    return {
      targetBranch: "main",
      generatedAt: 0,
      items: [],
      files: [],
      workItemCount: 0,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      loading: true,
    };
  }

  _startGitDiffSnapshotBuild() {
    if (this._diffSnapshotBuilding) return;
    this._diffSnapshotBuilding = true;
    const rows = this._getWiRows();
    Promise.resolve()
      .then(() => buildAdminGitDiffSnapshot({ projectDir: this.projectDir, workItems: rows }))
      .then((snapshot) => {
        this._diffSnapshotCache = snapshot;
      })
      .catch((err) => {
        this._diffSnapshotCache = {
          targetBranch: "main",
          generatedAt: Date.now(),
          items: [{ wiId: null, title: "Diff snapshot failed", status: "error", files: [], errors: [err?.message || String(err)] }],
          files: [],
          workItemCount: 0,
          fileCount: 0,
          additions: 0,
          deletions: 0,
        };
      })
      .finally(() => {
        this._diffSnapshotCacheAt = Date.now();
        this._diffSnapshotBuilding = false;
        this.requestRender({ force: true });
      });
  }

  _getSelectedGitDiffFile() {
    const snapshot = this._getGitDiffSnapshot();
    const files = snapshot.files || [];
    if (files.length === 0) {
      this._diffListIndex = 0;
      return null;
    }
    this._diffListIndex = Math.max(0, Math.min(this._diffListIndex, files.length - 1));
    return files[this._diffListIndex];
  }

  _buildGitDiffNavRows(snapshot = this._getGitDiffSnapshot()) {
    const rows = [];
    const fileRowMap = new Map();
    let fileIndex = 0;
    for (const item of snapshot.items || []) {
      const fileCount = item.files?.length || 0;
      const countText = fileCount === 1 ? "1 file" : `${fileCount} files`;
      const errorText = item.errors?.length ? ` ${C.red}!${C.reset}` : "";
      const status = item.status ? ` ${paletteStatusColor(item.status, C)}${item.status}${C.reset}` : "";
      rows.push({
        type: "wi",
        text: `${C.bold}WI#${item.wiId ?? "?"}${C.reset}${status} ${C.dim}${countText}${errorText}${C.reset}`,
      });
      if (item.errors?.length && fileCount === 0) {
        for (const error of item.errors.slice(0, 3)) {
          rows.push({ type: "error", text: `  ${C.red}!${C.reset} ${C.dim}${String(error).slice(0, 80)}${C.reset}` });
        }
      }
      for (const file of item.files || []) {
        const selected = fileIndex === this._diffListIndex;
        const pointer = selected ? `${C.yellow}>${C.reset}` : " ";
        const name = selected ? `${C.bold}${file.path}${C.reset}` : file.path;
        const badge = this._formatGitDiffBadge(file);
        const stats = this._formatGitDiffStats(file);
        fileRowMap.set(fileIndex, rows.length);
        rows.push({
          type: "file",
          fileIndex,
          text: `${pointer} ${badge} ${name}${stats ? ` ${C.dim}${stats}${C.reset}` : ""}`,
        });
        fileIndex++;
      }
    }
    this._diffNavRowMap = fileRowMap;
    return { rows, fileRowMap };
  }

  _syncGitDiffNavScroll(snapshot = this._getGitDiffSnapshot()) {
    const { rows, fileRowMap } = this._buildGitDiffNavRows(snapshot);
    const panelRows = this._diffPanelRows();
    const maxScroll = Math.max(0, rows.length - panelRows);
    const selectedRow = fileRowMap.get(this._diffListIndex);
    if (typeof selectedRow === "number") {
      if (selectedRow < this._diffNavScroll) this._diffNavScroll = selectedRow;
      else if (selectedRow >= this._diffNavScroll + panelRows) this._diffNavScroll = selectedRow - panelRows + 1;
    }
    this._diffNavScroll = Math.max(0, Math.min(this._diffNavScroll, maxScroll));
    return { rows, fileRowMap };
  }

  _moveGitDiffSelection(delta) {
    const snapshot = this._getGitDiffSnapshot();
    const files = snapshot.files || [];
    if (files.length === 0) return;
    this._diffListIndex = Math.max(0, Math.min(files.length - 1, this._diffListIndex + delta));
    this._diffPaneScroll = 0;
    this._syncGitDiffNavScroll(snapshot);
  }

  _enterGitDiffPane() {
    if (!this._getSelectedGitDiffFile()) return;
    this._diffFocus = "diff";
  }

  // Mirror of _getGitDiffSnapshot for the per-file diff text: build off the
  // render thread, return the cached detail (or a "loading" line) synchronously.
  _getGitDiffFileDetail(file = this._getSelectedGitDiffFile()) {
    if (!file) return { lines: ["No file selected."], hunkLineIndexes: [] };
    const key = `${this._diffSnapshotCache?.generatedAt || 0}:${file.key}`;
    const fresh = this._diffDetailCache && this._diffDetailCacheKey === key
      && (Date.now() - this._diffDetailCacheAt) < 3000;
    if (!fresh) this._startGitDiffFileDetailBuild(file, key);
    // Serve the cached detail while a refresh runs, but only when it is for the
    // SAME file — a snapshot refresh (new generatedAt) must not flash to
    // "loading", while switching files must not briefly show the prior file.
    if (this._diffDetailCache && this._diffDetailCacheFileKey === file.key) return this._diffDetailCache;
    return { lines: ["Loading diff…"], hunkLineIndexes: [] };
  }

  _startGitDiffFileDetailBuild(file, key) {
    if (this._diffDetailBuildingKey === key) return;
    this._diffDetailBuildingKey = key;
    Promise.resolve()
      .then(() => buildAdminGitDiffFileDetail({ projectDir: this.projectDir, file }))
      .then((detail) => {
        if (this._diffDetailBuildingKey !== key) return; // a newer selection won
        this._diffDetailCache = detail;
        this._diffDetailCacheKey = key;
        this._diffDetailCacheFileKey = file.key;
        this._diffDetailCacheAt = Date.now();
      })
      .catch((err) => {
        if (this._diffDetailBuildingKey !== key) return;
        this._diffDetailCache = { lines: [`Diff load failed: ${err?.message || err}`], hunkLineIndexes: [] };
        this._diffDetailCacheKey = key;
        this._diffDetailCacheFileKey = file.key;
        this._diffDetailCacheAt = Date.now();
      })
      .finally(() => {
        if (this._diffDetailBuildingKey === key) this._diffDetailBuildingKey = null;
        this.requestRender({ force: true });
      });
  }

  _scrollGitDiffPane(delta) {
    const detail = this._getGitDiffFileDetail();
    const maxScroll = Math.max(0, (detail.lines?.length || 0) - this._diffPanelRows());
    this._diffPaneScroll = Math.max(0, Math.min(maxScroll, this._diffPaneScroll + delta));
  }

  _jumpGitDiffHunk(direction) {
    const detail = this._getGitDiffFileDetail();
    const hunks = detail.hunkLineIndexes || [];
    if (hunks.length === 0) return;
    const current = this._diffPaneScroll;
    let next = null;
    if (direction > 0) {
      next = hunks.find((line) => line > current);
      if (next == null) next = hunks[0];
    } else {
      for (let i = hunks.length - 1; i >= 0; i--) {
        if (hunks[i] < current) {
          next = hunks[i];
          break;
        }
      }
      if (next == null) next = hunks[hunks.length - 1];
    }
    this._diffPaneScroll = Math.max(0, Math.min(next, Math.max(0, (detail.lines?.length || 0) - this._diffPanelRows())));
    this._diffFocus = "diff";
  }

  _formatGitDiffBadge(file) {
    const status = String(file.worktreeStatus || file.branchStatus || "?").slice(0, 3);
    const source = file.hasBranchDiff && file.hasWorktreeDiff
      ? "B+W"
      : file.hasBranchDiff ? "BR" : "WT";
    const color = file.untracked || status.startsWith("?")
      ? C.yellow
      : status.startsWith("A") ? C.green
        : status.startsWith("D") ? C.red
          : status.startsWith("R") ? C.cyan
            : C.yellow;
    return `${color}${status.padEnd(3)}${C.reset}${C.dim}/${source.padEnd(3)}${C.reset}`;
  }

  _formatGitDiffStats(file) {
    if (!file) return "";
    if (file.binary) return "binary";
    if (!Number.isFinite(file.additions) || !Number.isFinite(file.deletions)) return "";
    return `+${file.additions}/-${file.deletions}`;
  }

  _colorizeGitDiffLine(line) {
    const text = String(line ?? "");
    if (text.startsWith("# ")) return `${C.bold}${C.cyan}${text}${C.reset}`;
    if (text.startsWith("diff --git")) return `${C.bold}${text}${C.reset}`;
    if (text.startsWith("@@")) return `${C.cyan}${text}${C.reset}`;
    if (text.startsWith("+++") || text.startsWith("---")) return `${C.dim}${text}${C.reset}`;
    if (text.startsWith("+")) return `${C.green}${text}${C.reset}`;
    if (text.startsWith("-")) return `${C.red}${text}${C.reset}`;
    return text;
  }

  _buildGitDiffReview(width) {
    this._scroll = 0;
    this._tabScrolls[this._tab] = 0;
    const lines = [];
    const inner = Math.max(40, width - 2);
    const snapshot = this._getGitDiffSnapshot();
    const files = snapshot.files || [];

    lines.push("");
    lines.push(` ${C.bold}${C.cyan}═══ DIFF REVIEW ═══${C.reset}  ${C.dim}target ${snapshot.targetBranch || "main"} · ${snapshot.workItemCount || 0} WI · ${files.length} file${files.length === 1 ? "" : "s"} · +${snapshot.additions || 0}/-${snapshot.deletions || 0}${C.reset}`);
    lines.push("");

    if (files.length === 0) {
      if (snapshot.loading) {
        lines.push(`  ${C.dim}Loading diff review…${C.reset}`);
        lines.push("");
        return lines;
      }
      const errors = (snapshot.items || []).flatMap((item) => item.errors || []);
      lines.push(`  ${C.dim}No active WI branch or worktree diffs found.${C.reset}`);
      for (const error of errors.slice(0, 6)) {
        lines.push(`  ${C.red}!${C.reset} ${String(error).slice(0, inner - 5)}`);
      }
      lines.push("");
      return lines;
    }

    this._diffListIndex = Math.max(0, Math.min(this._diffListIndex, files.length - 1));
    const selected = files[this._diffListIndex];
    const detail = this._getGitDiffFileDetail(selected);
    const panelRows = this._diffPanelRows();
    const leftWidth = Math.max(28, Math.min(52, Math.floor(inner * 0.36)));
    const rightWidth = Math.max(20, inner - leftWidth - 3);
    const { rows: navRows } = this._syncGitDiffNavScroll(snapshot);
    const maxPaneScroll = Math.max(0, (detail.lines?.length || 0) - panelRows);
    this._diffPaneScroll = Math.max(0, Math.min(this._diffPaneScroll, maxPaneScroll));
    const maxNavScroll = Math.max(0, navRows.length - panelRows);
    this._diffNavScroll = Math.max(0, Math.min(this._diffNavScroll, maxNavScroll));

    const leftTitle = this._diffFocus === "nav" ? `${C.yellow}WI / files${C.reset}` : `${C.dim}WI / files${C.reset}`;
    const rightTitle = this._diffFocus === "diff"
      ? `${C.yellow}${selected.path}${C.reset}`
      : `${C.bold}${selected.path}${C.reset}`;
    const selectedStats = this._formatGitDiffStats(selected);
    const rightMeta = selectedStats ? ` ${C.dim}${selectedStats}${C.reset}` : "";
    lines.push(` ${fit(leftTitle, leftWidth)} ${C.dim}|${C.reset} ${fit(`${rightTitle}${rightMeta}`, rightWidth)}`);
    lines.push(` ${C.dim}${"-".repeat(leftWidth)}-+-${"-".repeat(rightWidth)}${C.reset}`);

    for (let i = 0; i < panelRows; i++) {
      const navLine = navRows[this._diffNavScroll + i]?.text || "";
      const diffLine = detail.lines?.[this._diffPaneScroll + i] || "";
      lines.push(` ${fit(navLine, leftWidth)} ${C.dim}|${C.reset} ${fit(this._colorizeGitDiffLine(diffLine), rightWidth)}`);
    }

    return lines;
  }

  _buildWorkItemsTab(width) {
    if (this._selectedCall != null) return this._buildAgentCallDetail(width, this._selectedCall);
    if (this._selectedWi != null) return this._buildWorkItemDetail(width, this._selectedWi);
    return this._buildWorkItemList(width);
  }

  _buildWorkItemList(width) {
    const lines = [];
    const inner = width - 2;
    this._wiRowMap = new Map();
    const rows = this._getWiRows();

    lines.push("");
    lines.push(` ${C.bold}${C.cyan}═══ WORK ITEMS ═══${C.reset}  ${C.dim}(${rows.length} item${rows.length !== 1 ? "s" : ""})${C.reset}`);
    lines.push("");

    if (rows.length === 0) {
      lines.push(`  ${C.dim}No work items yet.${C.reset}`);
      lines.push("");
      return lines;
    }

    this._wiListIndex = Math.max(0, Math.min(this._wiListIndex, rows.length - 1));

    let tCalls = 0, tIn = 0, tOut = 0, tDur = 0, tTools = 0, tCost = 0;
    for (const r of rows) {
      tCalls += r.call_count || 0;
      tIn += r.input_tokens || 0;
      tOut += r.output_tokens || 0;
      tDur += r.total_duration_ms || 0;
      tTools += r.tool_calls || 0;
      tCost += Number(r.cost_usd) || 0;
    }

    const hdr = `  ${"ID".padStart(4)} ${"Status".padEnd(14)} ${"Calls".padStart(6)} ${"Tokens".padStart(10)} ${"Tools".padStart(6)} ${"Duration".padStart(10)} ${"Cost".padStart(8)}  Title`;
    lines.push(` ${C.dim}${hdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(hdr.length + 2, inner))}${C.reset}`);

    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const tok = (r.input_tokens || 0) + (r.output_tokens || 0);
      const statusColor = paletteStatusColor(r.status, C);
      const statusText = statusColor + (r.status || "?").slice(0, 14).padEnd(14) + C.reset;
      const isSelected = idx === this._wiListIndex;
      const marker = isSelected ? `${C.yellow}>${C.reset}` : " ";
      const idStr = isSelected ? `${C.yellow}${String(r.id).padStart(4)}${C.reset}` : String(r.id).padStart(4);
      const titleText = (r.title || "").slice(0, Math.max(10, inner - 70));
      const row = `${marker} ${idStr} ${statusText} ${String(r.call_count || 0).padStart(6)} ${fmtTokens(tok).padStart(10)} ${String(r.tool_calls || 0).padStart(6)} ${fmtDuration(r.total_duration_ms || 0).padStart(10)} ${fmtUsd(r.cost_usd || 0).padStart(8)}  ${titleText}`;
      this._wiRowMap.set(idx, lines.length);
      lines.push(row);
    }

    lines.push(` ${C.dim}${"─".repeat(Math.min(hdr.length + 2, inner))}${C.reset}`);
    lines.push(
      `  ${C.bold}TTL${C.reset} ${" ".padEnd(15)}` +
      `${C.bold}${String(tCalls).padStart(6)}${C.reset} ` +
      `${C.bold}${fmtTokens(tIn + tOut).padStart(10)}${C.reset} ` +
      `${C.bold}${String(tTools).padStart(6)}${C.reset} ` +
      `${C.bold}${fmtDuration(tDur).padStart(10)}${C.reset} ` +
      `${C.bold}${fmtUsd(tCost).padStart(8)}${C.reset}`
    );
    lines.push("");
    lines.push(` ${C.dim}Press Enter to open the highlighted work item.${C.reset}`);
    lines.push("");
    return lines;
  }

  _buildWorkItemDetail(width, wiId) {
    const lines = [];
    const inner = width - 2;
    this._callRowMap = new Map();

    const rows = this._getWiRows();
    const wi = rows.find((r) => r.id === wiId);
    const calls = this._getWiCalls(wiId);

    lines.push("");
    if (!wi) {
      lines.push(` ${C.red}Work item ${wiId} not found.${C.reset}`);
      return lines;
    }

    lines.push(` ${C.bold}${C.cyan}═══ WORK ITEM #${wi.id} ═══${C.reset}  ${C.dim}${(wi.title || "").slice(0, inner - 30)}${C.reset}`);
    lines.push("");

    const statusColor = paletteStatusColor(wi.status, C);
    lines.push(`  Status: ${statusColor}${wi.status || "?"}${C.reset}   Priority: ${wi.priority || "?"}   Mode: ${wi.mode || "?"}   Jobs: ${wi.job_count || 0}`);
    if (wi.branch_name) {
      const mergeTxt = wi.merge_state ? `   Merge: ${wi.merge_state === "merged" ? C.green : C.yellow}${wi.merge_state}${C.reset}` : "";
      lines.push(`  Branch: ${C.dim}${wi.branch_name}${C.reset}${mergeTxt}`);
    }
    if (wi.created_at) {
      const endTxt = wi.completed_at ? `   Completed: ${C.dim}${fmtDate(wi.completed_at)}${C.reset}`
        : wi.started_at ? `   Started: ${C.dim}${fmtDate(wi.started_at)}${C.reset}` : "";
      lines.push(`  Created: ${C.dim}${fmtDate(wi.created_at)}${C.reset}${endTxt}`);
    }
    lines.push("");

    const tok = (wi.input_tokens || 0) + (wi.output_tokens || 0);
    lines.push(`  ${C.bold}Totals${C.reset}`);
    lines.push(`    Agent Calls: ${C.bold}${wi.call_count || 0}${C.reset}  ${C.dim}(${wi.succeeded_calls || 0} ok / ${wi.failed_calls || 0} failed / ${wi.running_calls || 0} running)${C.reset}`);
    lines.push(`    Tokens:      ${C.bold}${fmtTokens(tok)}${C.reset}  ${C.dim}(${fmtTokens(wi.input_tokens || 0)} in${wi.cached_input_tokens > 0 ? `, ${fmtTokens(wi.cached_input_tokens || 0)} cached` : ""} + ${fmtTokens(wi.output_tokens || 0)} out)${C.reset}`);
    lines.push(`    Tool Calls:  ${C.bold}${wi.tool_calls || 0}${C.reset}`);
    lines.push(`    Duration:    ${C.bold}${fmtDuration(wi.total_duration_ms || 0)}${C.reset}`);
    lines.push(`    Cost:        ${C.bold}${fmtUsd(wi.cost_usd || 0)}${C.reset}`);
    lines.push("");

    if (calls.length === 0) {
      lines.push(`  ${C.dim}No agent calls recorded for this work item yet.${C.reset}`);
      lines.push("");
      return lines;
    }

    this._callListIndex = Math.max(0, Math.min(this._callListIndex, calls.length - 1));

    const hdr = `  ${"#".padStart(3)} ${"Role".padEnd(12)} ${"Provider".padEnd(9)} ${"Model".padEnd(14)} ${"Tier".padEnd(9)} ${"Status".padEnd(10)} ${"Tokens".padStart(10)} ${"Tools".padStart(5)} ${"Dur".padStart(8)}`;
    lines.push(` ${C.bold}Agent Calls${C.reset}  ${C.dim}(${calls.length})${C.reset}`);
    lines.push(` ${C.dim}${hdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(hdr.length + 2, inner))}${C.reset}`);

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const color = roleBrandColor(c.role);
      const callTok = (c.input_tokens || 0) + (c.output_tokens || 0);
      const sColor = c.status === "succeeded" ? C.green : c.status === "failed" ? C.red : c.status === "running" ? C.yellow : C.dim;
      const isSelected = i === this._callListIndex;
      const marker = isSelected ? `${C.yellow}>${C.reset}` : " ";
      const num = isSelected ? `${C.yellow}${String(i + 1).padStart(3)}${C.reset}` : String(i + 1).padStart(3);
      const modelText = String(c.model_name || c.model_tier || "?").slice(0, 14).padEnd(14);
      const row = `${marker} ${num} ${color}${String(c.role || "?").padEnd(12)}${C.reset} ${String(c.provider || "?").padEnd(9)} ${modelText} ${String(c.model_tier || "?").padEnd(9)} ${sColor}${String(c.status || "?").padEnd(10)}${C.reset} ${fmtTokens(callTok).padStart(10)} ${String(c.tool_calls || 0).padStart(5)} ${fmtDuration(c.duration_ms || 0).padStart(8)}`;
      this._callRowMap.set(i, lines.length);
      lines.push(row);
    }

    lines.push("");
    lines.push(` ${C.dim}Press Enter to open the highlighted call.${C.reset}`);
    lines.push("");
    return lines;
  }

  _buildAgentCallDetail(width, callId) {
    const lines = [];
    const inner = width - 2;

    let call = null;
    try { call = getAgentCallById(callId); } catch { call = null; }

    lines.push("");
    if (!call) {
      lines.push(` ${C.red}Agent call ${callId} not found.${C.reset}`);
      return lines;
    }

    lines.push(` ${C.bold}${C.cyan}═══ AGENT CALL #${call.id} ═══${C.reset}  ${C.dim}WI#${call.work_item_id} · Job #${call.job_id}${C.reset}`);
    lines.push("");

    const statusColor = paletteStatusColor(call.status, C);
    const tok = (call.input_tokens || 0) + (call.output_tokens || 0);

    lines.push(`  Role:     ${C.bold}${call.role || "?"}${C.reset}   Activity: ${call.activity || "—"}`);
    lines.push(`  Provider: ${C.bold}${call.provider || "?"}${C.reset}   Model: ${call.model_name || "?"}   Tier: ${call.model_tier || "?"}`);
    lines.push(`  Status:   ${statusColor}${call.status || "?"}${C.reset}   Exit: ${call.exit_code == null ? "—" : String(call.exit_code)}   Reasoning: ${call.reasoning_effort || "—"}`);
    lines.push(`  Started:  ${C.dim}${fmtDate(call.started_at)}${C.reset}${call.finished_at ? `   Finished: ${C.dim}${fmtDate(call.finished_at)}${C.reset}` : ""}`);
    lines.push("");

    lines.push(`  ${C.bold}Telemetry${C.reset}`);
    lines.push(`    Tokens:    ${C.bold}${fmtTokens(tok)}${C.reset}  ${C.dim}(${fmtTokens(call.input_tokens || 0)} in${call.cached_input_tokens > 0 ? `, ${fmtTokens(call.cached_input_tokens || 0)} cached` : ""} + ${fmtTokens(call.output_tokens || 0)} out)${C.reset}`);
    lines.push(`    Chars:     in=${C.bold}${call.prompt_chars || 0}${C.reset}  out=${C.bold}${call.output_chars || 0}${C.reset}`);
    lines.push(`    Duration:  ${C.bold}${fmtDuration(call.duration_ms || 0)}${C.reset}`);
    lines.push(`    Cost:      ${C.bold}${fmtUsd(call.cost_estimate_usd || 0)}${C.reset}`);
    if (call.atlas_method) lines.push(`    ATLAS:       ${C.bold}${call.atlas_method}${C.reset}${call.atlas_prefetch_status ? ` (${call.atlas_prefetch_status})` : ""}`);
    if (call.error_text) {
      lines.push(`    ${C.red}Error:${C.reset}  ${String(call.error_text).slice(0, inner - 14)}`);
    }
    lines.push("");

    let tools = [];
    try { tools = getToolInvocationsForAgentCall(callId) || []; } catch { tools = []; }
    lines.push(`  ${C.bold}Tool Calls${C.reset}  ${C.dim}(${tools.length})${C.reset}`);
    if (tools.length === 0) {
      lines.push(`    ${C.dim}No tool invocations recorded in this call's window.${C.reset}`);
    } else {
      for (const t of tools.slice(0, 50)) {
        const name = String(t.observation_type || "").replace(/^tool\./, "");
        const summary = String(t.summary || "").replace(/\s+/g, " ").slice(0, inner - 26);
        lines.push(`    ${C.dim}${name.padEnd(16)}${C.reset} ${summary}`);
      }
      if (tools.length > 50) lines.push(`    ${C.dim}... (${tools.length - 50} more)${C.reset}`);
    }
    lines.push("");

    let prompts = [];
    try { prompts = readRecentPrompts({ limit: 1, agentCallId: callId }); } catch { prompts = []; }
    const prompt = prompts[0];
    lines.push(`  ${C.bold}Prompt${C.reset}${prompt ? `  ${C.dim}(${prompt.prompt_chars || 0} chars, ts ${prompt.ts})${C.reset}` : ""}`);
    if (!prompt) {
      lines.push(`    ${C.dim}Not in log (older than 3-day retention, or captured before agent_call_id was added).${C.reset}`);
    } else {
      const promptText = String(prompt.prompt || "");
      const promptLines = promptText.split("\n").slice(0, 80);
      for (const pl of promptLines) lines.push(`    ${C.dim}${pl.slice(0, inner - 6)}${C.reset}`);
      const total = promptText.split("\n").length;
      if (total > 80) lines.push(`    ${C.dim}... (${total - 80} more prompt lines)${C.reset}`);
    }
    lines.push("");

    let outputs = [];
    try { outputs = readRecentOutputs({ limit: 1, agentCallId: callId }); } catch { outputs = []; }
    const out = outputs[0];
    lines.push(`  ${C.bold}Output${C.reset}${out ? `  ${C.dim}(${out.output_chars || 0} chars, ts ${out.ts})${C.reset}` : ""}`);
    if (!out) {
      lines.push(`    ${C.dim}Not captured (pre-rework call, 3-day retention, or running call).${C.reset}`);
    } else {
      const outText = String(out.output || "");
      const outLines = outText.split("\n").slice(0, 80);
      for (const ol of outLines) lines.push(`    ${C.dim}${ol.slice(0, inner - 6)}${C.reset}`);
      const total = outText.split("\n").length;
      if (total > 80) lines.push(`    ${C.dim}... (${total - 80} more output lines)${C.reset}`);
    }
    lines.push("");
    return lines;
  }

  // ── Tab 3: Settings ───────────────────────────────────────────────────

  _queryAtlasReportRows() {
    return queryAtlasReportRows();
  }

  _buildAtlasReport(width) {
    return buildAtlasReport(width, { projectDir: this.projectDir });
  }

  _buildLogs(width) {
    const source = this._logSource === "outputs" ? "outputs" : "prompts";
    const lines = [];
    const inner = width - 2;
    this._promptRowMap = new Map();
    const sourceBar = ADMIN_LOG_SOURCES.map((entry) => (
      entry.id === source
        ? `${C.bold}${C.cyan}[${entry.label}]${C.reset}`
        : `${C.dim}${entry.label}${C.reset}`
    )).join(` ${C.dim}|${C.reset} `);
    lines.push("");
    lines.push(` ${C.bold}${C.cyan}\u2550\u2550\u2550 LOGS \u2550\u2550\u2550${C.reset}  ${sourceBar}  ${C.dim}(\u2190\u2192 to switch)${C.reset}`);
    lines.push(` ${C.dim}Last 3 days of provider ${source}. Shown newest first.${C.reset}`);
    lines.push(` ${C.dim}Press ${C.bold}x${C.reset}${C.dim} to purge disk logs, DB work-item history, and ATLAS report telemetry.${C.reset}`);
    if (this._purgeLogsConfirm) {
      lines.push(` ${C.red}${C.bold}Confirm purge:${C.reset} ${C.red}this deletes runtime log files, terminal WI history, DB log rows, and ATLAS report telemetry. Press y to confirm, n/Esc to cancel.${C.reset}`);
    } else if (this._purgeLogsMessage) {
      lines.push(` ${C.green}${this._purgeLogsMessage}${C.reset}`);
    }
    lines.push("");

    if (source === "outputs") {
      this._appendOutputLogLines(lines, inner);
      return lines;
    }

    let records;
    try {
      records = readRecentPrompts({ limit: 200 });
    } catch (err) {
      this._promptCount = 0;
      lines.push(` ${C.red}Failed to read prompt log:${C.reset} ${err?.message || err}`);
      lines.push("");
      return lines;
    }
    this._promptCount = Array.isArray(records) ? records.length : 0;

    if (!records || records.length === 0) {
      lines.push(` ${C.dim}No prompts recorded yet. Run a job to populate this log.${C.reset}`);
      lines.push("");
      return lines;
    }

    if (this._promptExpanded >= 0 && this._promptExpanded < records.length) {
      const rec = records[this._promptExpanded];
      const ts = String(rec.ts || "").replace("T", " ").replace(/\..*$/, "");
      const role = String(rec.role || "?");
      const provider = String(rec.provider || "?");
      const model = String(rec.model || "?");
      const tier = String(rec.model_tier || "?");
      const jobTag = rec.job_id != null ? `job#${rec.job_id}` : "job#?";
      const wiTag = rec.work_item_id != null ? `wi#${rec.work_item_id}` : "";
      const activity = rec.activity ? ` activity=${rec.activity}` : "";
      const attempt = rec.attempt != null ? ` attempt=${rec.attempt}` : "";
      lines.push(` ${C.bold}${ts}${C.reset}  ${C.cyan}${role}${C.reset} ${C.dim}${provider}/${model} (${tier})${C.reset}`);
      const systemText = String(rec.system_prompt || "");
      const userPromptText = String(rec.prompt || "");
      const inlineSystemDuplicate = !!systemText
        && userPromptText.trimStart().startsWith(`SYSTEM INSTRUCTIONS:\n${systemText}`);
      const sysChars = inlineSystemDuplicate ? 0 : Number(rec.system_prompt_chars || 0);
      const sysFiles = Array.isArray(rec.system_prompt_files) ? rec.system_prompt_files.length : 0;
      const sysSummary = sysChars > 0 || sysFiles > 0
        ? `  system=${sysChars || 0} chars${sysFiles ? `/${sysFiles} files` : ""}`
        : "";
      lines.push(` ${C.dim}${jobTag} ${wiTag}${activity}${attempt}  chars=${rec.prompt_chars || 0}${sysSummary}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 90))}${C.reset}`);
      let jobRow = null;
      if (rec.job_id != null) {
        try { jobRow = getJob(rec.job_id); } catch { jobRow = null; }
      }
      let currentContract = "";
      let currentContractRole = "";
      try {
        const preview = buildCurrentRoleContract({
          job: jobRow,
          providerName: provider,
          projectDir: this.projectDir,
        });
        currentContract = preview.contract || "";
        currentContractRole = preview.role || "";
      } catch {
        currentContract = "";
      }
      const persistedContext = String(jobRow?.context_text || "");
      const pushPreviewBlock = (title, text, { maxLines = 80, dim = false } = {}) => {
        const value = String(text || "");
        if (!value.trim()) return false;
        lines.push(` ${C.bold}${title}${C.reset}`);
        const blockLines = value.split(/\r?\n/);
        for (const rawLine of blockLines.slice(0, maxLines)) {
          const color = dim ? C.dim : "";
          const reset = dim ? C.reset : "";
          if (!rawLine) { lines.push(""); continue; }
          let remaining = rawLine;
          while (remaining.length > inner - 2) {
            lines.push(` ${color}${remaining.slice(0, inner - 2)}${reset}`);
            remaining = remaining.slice(inner - 2);
          }
          lines.push(` ${color}${remaining}${reset}`);
        }
        if (blockLines.length > maxLines) lines.push(` ${C.dim}... (${blockLines.length - maxLines} more lines)${C.reset}`);
        lines.push("");
        return true;
      };

      pushPreviewBlock(
        `CURRENT ROLE CONTRACT${currentContractRole ? ` (${currentContractRole})` : ""} - reconstructed from current code`,
        currentContract,
        { maxLines: 40, dim: true },
      );
      if (persistedContext) {
        pushPreviewBlock("PERSISTED JOB CONTEXT (jobs.context_text)", persistedContext, { maxLines: 80 });
      } else if (jobRow) {
        lines.push(` ${C.bold}PERSISTED JOB CONTEXT (jobs.context_text)${C.reset}`);
        lines.push(` ${C.dim}(none recorded for this job; historical prompt log below is ground truth)${C.reset}`);
        lines.push("");
      }

      if (rec.system_prompt && !inlineSystemDuplicate) {
        lines.push(` ${C.bold}RECORDED SYSTEM PROMPT / ATTACHED ROLE CONTRACTS${C.reset}`);
        const systemLines = systemText.split(/\r?\n/).slice(0, 40);
        for (const sl of systemLines) lines.push(` ${C.dim}${sl.slice(0, inner - 2)}${C.reset}`);
        const systemTotal = systemText.split(/\r?\n/).length;
        if (systemTotal > 40) lines.push(` ${C.dim}... (${systemTotal - 40} more system prompt lines)${C.reset}`);
        lines.push("");
        lines.push(` ${C.bold}RECORDED USER PROMPT / HANDOFF CONTEXT${C.reset}`);
      } else {
        lines.push(` ${C.bold}RECORDED PROVIDER PROMPT${C.reset}`);
      }
      const text = userPromptText;
      const paragraphs = text.split(/\r?\n/);
      for (const line of paragraphs) {
        if (!line) { lines.push(""); continue; }
        let remaining = line;
        while (remaining.length > inner - 2) {
          lines.push(` ${remaining.slice(0, inner - 2)}`);
          remaining = remaining.slice(inner - 2);
        }
        lines.push(` ${remaining}`);
      }
      lines.push("");
      return lines;
    }

    lines.push(` ${C.dim}Showing ${records.length} prompts. Use ↑↓ to scroll, j/k to select, Enter to view full prompt.${C.reset}`);
    lines.push("");
    const hdr = `  ${"#".padStart(3)} ${"When".padEnd(19)} ${"Role".padEnd(11)} ${"Provider".padEnd(9)} ${"Model".padEnd(18)} ${"Job".padEnd(9)} ${"WI".padEnd(6)} ${"Chars".padStart(7)}  Preview`;
    lines.push(` ${C.dim}${hdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, hdr.length + 2))}${C.reset}`);

    const selected = this._promptSelected ?? 0;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const ts = String(rec.ts || "").replace("T", " ").replace(/\..*$/, "");
      const role = String(rec.role || "?").slice(0, 11);
      const provider = String(rec.provider || "?").slice(0, 9);
      const model = String(rec.model || "?").slice(0, 18);
      const jobTag = rec.job_id != null ? `j#${rec.job_id}` : "j#?";
      const wiTag = rec.work_item_id != null ? `w#${rec.work_item_id}` : "";
      const chars = String(rec.prompt_chars || 0);
      const preview = promptPreviewText(rec, { max: Math.max(10, inner - 95) });
      const marker = i === selected ? `${C.yellow}>${C.reset}` : " ";
      const numStr = String(i + 1).padStart(3);
      const rowColor = i === selected ? C.bold : "";
      this._promptRowMap.set(i, lines.length);
      lines.push(
        `${marker} ${rowColor}${numStr} ${ts.padEnd(19)} ${role.padEnd(11)} ${provider.padEnd(9)} ${model.padEnd(18)} ${jobTag.padEnd(9)} ${wiTag.padEnd(6)} ${chars.padStart(7)}  ${preview}${C.reset}`
      );
    }
    lines.push("");
    return lines;
  }

  // Output-log view of the Logs tab. Shares selection/expansion state with
  // the prompts view (_promptSelected/_promptExpanded) so j/k and Enter work
  // identically across sources.
  _appendOutputLogLines(lines, inner) {
    let records;
    try {
      records = readRecentOutputs({ limit: 200 });
    } catch (err) {
      this._promptCount = 0;
      lines.push(` ${C.red}Failed to read output log:${C.reset} ${err?.message || err}`);
      lines.push("");
      return;
    }
    this._promptCount = Array.isArray(records) ? records.length : 0;

    if (!records || records.length === 0) {
      lines.push(` ${C.dim}No outputs recorded yet. Run a job to populate this log.${C.reset}`);
      lines.push("");
      return;
    }

    if (this._promptExpanded >= 0 && this._promptExpanded < records.length) {
      const rec = records[this._promptExpanded];
      const ts = String(rec.ts || "").replace("T", " ").replace(/\..*$/, "");
      const role = String(rec.role || "?");
      const provider = String(rec.provider || "?");
      const model = String(rec.model || "?");
      const tier = String(rec.model_tier || "?");
      const jobTag = rec.job_id != null ? `job#${rec.job_id}` : "job#?";
      const wiTag = rec.work_item_id != null ? `wi#${rec.work_item_id}` : "";
      const statusColor = rec.status === "succeeded" ? C.green : rec.status === "failed" ? C.red : C.dim;
      lines.push(` ${C.bold}${ts}${C.reset}  ${C.cyan}${role}${C.reset} ${C.dim}${provider}/${model} (${tier})${C.reset}  ${statusColor}${rec.status || "?"}${C.reset}`);
      const tokens = `${fmtTokens(Number(rec.input_tokens) || 0)} in + ${fmtTokens(Number(rec.output_tokens) || 0)} out`;
      const duration = rec.duration_ms != null ? `  ${fmtDuration(Number(rec.duration_ms) || 0)}` : "";
      const activity = rec.activity ? ` activity=${rec.activity}` : "";
      const attempt = rec.attempt != null ? ` attempt=${rec.attempt}` : "";
      lines.push(` ${C.dim}${jobTag} ${wiTag}${activity}${attempt}  chars=${rec.output_chars || 0}  ${tokens}${duration}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 90))}${C.reset}`);
      if (rec.error_text) {
        lines.push(` ${C.red}Error:${C.reset} ${String(rec.error_text).replace(/\s+/g, " ").slice(0, Math.max(10, inner - 10))}`);
        lines.push("");
      }
      const text = String(rec.output || "");
      for (const line of text.split(/\r?\n/)) {
        if (!line) { lines.push(""); continue; }
        let remaining = line;
        while (remaining.length > inner - 2) {
          lines.push(` ${remaining.slice(0, inner - 2)}`);
          remaining = remaining.slice(inner - 2);
        }
        lines.push(` ${remaining}`);
      }
      lines.push("");
      return;
    }

    lines.push(` ${C.dim}Showing ${records.length} outputs. Use ↑↓ to scroll, j/k to select, Enter to view full output.${C.reset}`);
    lines.push("");
    const hdr = `  ${"#".padStart(3)} ${"When".padEnd(19)} ${"Role".padEnd(11)} ${"Provider".padEnd(9)} ${"Model".padEnd(18)} ${"Job".padEnd(9)} ${"WI".padEnd(6)} ${"Status".padEnd(9)} ${"Chars".padStart(7)}  Preview`;
    lines.push(` ${C.dim}${hdr}${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, hdr.length + 2))}${C.reset}`);

    const selected = this._promptSelected ?? 0;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const ts = String(rec.ts || "").replace("T", " ").replace(/\..*$/, "");
      const role = String(rec.role || "?").slice(0, 11);
      const provider = String(rec.provider || "?").slice(0, 9);
      const model = String(rec.model || "?").slice(0, 18);
      const jobTag = rec.job_id != null ? `j#${rec.job_id}` : "j#?";
      const wiTag = rec.work_item_id != null ? `w#${rec.work_item_id}` : "";
      const status = String(rec.status || "?").slice(0, 9);
      const chars = String(rec.output_chars || 0);
      const preview = String(rec.output || "").replace(/\s+/g, " ").trim().slice(0, Math.max(10, inner - 105));
      const marker = i === selected ? `${C.yellow}>${C.reset}` : " ";
      const numStr = String(i + 1).padStart(3);
      const rowColor = i === selected ? C.bold : "";
      this._promptRowMap.set(i, lines.length);
      lines.push(
        `${marker} ${rowColor}${numStr} ${ts.padEnd(19)} ${role.padEnd(11)} ${provider.padEnd(9)} ${model.padEnd(18)} ${jobTag.padEnd(9)} ${wiTag.padEnd(6)} ${status.padEnd(9)} ${chars.padStart(7)}  ${preview}${C.reset}`
      );
    }
    lines.push("");
  }

  _buildSettings(...args) {
    return this._settingsController._buildSettings.call(this, ...args);
  }
}
