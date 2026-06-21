// lib/provider/codex.js
//
// Native Codex CLI provider for the posse orchestrator.
// Uses `codex exec` in non-interactive mode and maps the result onto the
// shared provider interface expected by worker.js / assessor.js.

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../queue/functions/index.js";
import { adaptExecutionContractForProvider, appendExecutionTools, buildExecutionContract, renderExecutionContractBlock, WEB_TOOL_ROLES } from "../../../functions/tools/contract.js";
import { buildMcpAtlasSurfaceToolDescriptors, buildMcpSurfaceToolDescriptors, buildSurfaceNameMap } from "../../../functions/tools/mcp-surface.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, logAtlasAttachment, resolveAtlasAssignmentUnit, resolveAtlasExecutionAttachment } from "../../integrations/functions/atlas.js";
import { atlasBackendLabel } from "../../integrations/functions/atlas-label.js";
import { buildDeterministicReadMcpServerConfig, buildDeterministicReadMcpServerConfigAsync, getDeterministicMcpToolNames, releaseDeterministicMcpServerSession, roleUsesDeterministicReadMcp } from "../../integrations/functions/deterministic-mcp.js";
import { isFallbackAtlasPrefetchStatus } from "../../integrations/functions/deterministic-mcp/gate.js";
import { resolveAtlasToolGateEnabled } from "../../integrations/functions/deterministic-mcp/gate-settings.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../integrations/functions/mcp-gateway.js";
import { C, ask, askMultiline, extractJson as _extractJsonClaude, resolveDisableSystemTools, resolveWebToolsEnabled } from "./claude.js";
import { buildRuntimeEnv, normalizeProviderPaths } from "../../runtime/functions/paths.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { providerRuntimeState } from "../classes/runtime-state-singleton.js";
import { CODEX_OAUTH_SUPPORTED_MODELS, getProviderTierDefaults } from "./model-catalog.js";
import { hasProviderVisibleAtlasMcpTools } from "./helpers/atlas-mcp.js";
import { logProviderMcpSurfaceTelemetry, logProviderCliStderrTelemetry, logProviderMcpAttachProofTelemetry } from "./helpers/mcp-telemetry.js";
import { buildWindowsSpawn, terminateSpawnedProcess } from "./helpers/windows-spawn.js";
import { discoverCommandCandidates } from "./helpers/cli-discovery.js";
import { selectExecutionModel } from "./helpers/model-selection.js";
import {
  InteractiveCliSession,
  InteractiveCliUnavailableError,
  getDefaultInteractiveCliBackend,
  stripTerminalControls,
} from "./helpers/interactive-cli-session.js";
import { escalateModelTier, getMaxTurnsForProvider } from "./helpers/turns.js";
import { resolveProviderStallTimeout } from "./helpers/stall-timeout.js";
import { classifyProviderError } from "./helpers/api-resilience.js";
import { loadUsageEntries, summarizeUsageEntries } from "./helpers/local-usage-summary.js";
import { roleBrandColor, roleBrandIcon } from "../../ui/functions/display/helpers/brand.js";
import { isWebToolName, recordToolUseObservations } from "../../observability/functions/observations.js";

export const capabilities = Object.freeze({
  images: false,
  sessionResume: true,
  toolAttachment: "deterministic-bridge",
});

function codexMcpSurfaceExample(canonicalName) {
  return buildMcpSurfaceToolDescriptors([canonicalName], {
    providerName: "codex",
    serverName: "posse_gateway",
  })[0]?.providerSurfaceName || String(canonicalName || "").trim();
}

const CODEX_EDIT_FILE_EXAMPLE = codexMcpSurfaceExample("edit_file");

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("codex").cheap.model,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("codex").standard.model,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("codex").strong.model,
    label: "STRONG",
    color: "magenta",
  },
};

const CODEX_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session (5h)", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week (7d)", durationMs: 7 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_CODEX_USAGE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_CODEX_USAGE_BACKOFF_MS = 5 * 60 * 1000;

const CODEX_EXIT_CLEANUPS = new Set();
let codexExitCleanupHandler = null;

function drainCodexExitCleanups() {
  const handler = codexExitCleanupHandler;
  const pending = [...CODEX_EXIT_CLEANUPS];
  CODEX_EXIT_CLEANUPS.clear();
  codexExitCleanupHandler = null;
  if (handler) {
    try { process.removeListener("exit", handler); } catch { /* best effort */ }
  }
  for (const cleanup of pending) {
    try { cleanup(); } catch { /* one cleanup must not block the rest */ }
  }
}

function registerCodexExitCleanup(cleanup) {
  if (typeof cleanup !== "function") return () => {};
  CODEX_EXIT_CLEANUPS.add(cleanup);
  if (!codexExitCleanupHandler) {
    codexExitCleanupHandler = drainCodexExitCleanups;
    process.once("exit", codexExitCleanupHandler);
  }
  return () => {
    CODEX_EXIT_CLEANUPS.delete(cleanup);
    if (CODEX_EXIT_CLEANUPS.size === 0 && codexExitCleanupHandler) {
      try { process.removeListener("exit", codexExitCleanupHandler); } catch { /* best effort */ }
      codexExitCleanupHandler = null;
    }
  };
}
let _usageSummaryCache = null;
let _interactiveUsageUnavailableReason = null;
let _testFetchCodexStatusViaInteractive = null;
let _testFetchCodexRateLimitsViaAppServer = null;

const OAUTH_SUPPORTED_MODELS = new Set(CODEX_OAUTH_SUPPORTED_MODELS);

function resolveOauthCompatibleModel(preferredModel) {
  const standardModel = getProviderTierDefaults("codex")?.standard?.model || "gpt-5.4";
  const preferred = String(preferredModel || "").trim();
  if (OAUTH_SUPPORTED_MODELS.has(preferred)) return preferred;

  const fallbackCandidates = [
    standardModel,
    getModelTierConfig("standard").model,
    getModelOverride(),
    getModelTierConfig("strong").model,
    ...CODEX_OAUTH_SUPPORTED_MODELS,
  ];
  for (const candidate of fallbackCandidates) {
    const normalized = String(candidate || "").trim();
    if (OAUTH_SUPPORTED_MODELS.has(normalized)) return normalized;
  }
  return standardModel;
}

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function readPositiveMsSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function codexUsageCacheMs() {
  return readPositiveMsSetting(SETTING_KEYS.CODEX_USAGE_CACHE_MS, DEFAULT_CODEX_USAGE_CACHE_MS);
}

function codexUsageBackoffMs() {
  return readPositiveMsSetting(SETTING_KEYS.CODEX_USAGE_BACKOFF_MS, DEFAULT_CODEX_USAGE_BACKOFF_MS);
}

function getModelOverride() {
  return readModelSetting("codex_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`codex_model_${key}`) || base.model,
  };
}

function normalizeModelForAuthMode(modelName, authMode) {
  const model = String(modelName || "").trim();
  if (!model) return modelName;
  if (authMode !== "login" && authMode !== "oauth") return model;
  return resolveOauthCompatibleModel(model);
}

export function __testNormalizeModelForAuthMode(modelName, authMode) {
  return normalizeModelForAuthMode(modelName, authMode);
}

function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider("codex", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

const CODEX_STREAM_CAPTURE_MAX_CHARS = 4 * 1024 * 1024;

function appendBoundedCodexOutput(current, text, maxChars = CODEX_STREAM_CAPTURE_MAX_CHARS) {
  const next = `${current || ""}${text || ""}`;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

export function __testAppendBoundedCodexOutput(current, text, maxChars) {
  return appendBoundedCodexOutput(current, text, maxChars);
}

export function __testBuildCloseStats({
  role,
  modelTier,
  reasoningEffort,
  modelName,
  totalInputTokens,
  totalOutputTokens,
  longContextInputTokens = null,
  durationMs,
  finalOutput,
  stdout,
  code,
  atlasMethod = "baseline",
  toolUses = [],
  toolUsesLoggedByToolkit = false,
  sessionHandle = null,
  priorSessionHandle = null,
  sessionExpired = false,
}) {
  return {
    role,
    modelTier,
    reasoningEffort,
    modelName,
    provider: "codex",
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    longContextInputTokens,
    durationMs,
    outputChars: (finalOutput || stdout.trim()).length,
    exitCode: code,
    atlasMethod,
    toolUses: Array.isArray(toolUses) ? toolUses : [],
    toolUsesLoggedByToolkit: !!toolUsesLoggedByToolkit,
    sessionHandle: sessionHandle || null,
    priorSessionHandle: priorSessionHandle || null,
    sessionExpired: !!sessionExpired,
  };
}

export function __testClassifyCodexStderrLine(line) {
  const text = String(line || "").trim();
  if (!text) return { kind: "empty", display: null };
  if (
    /The token '&&' is not a valid statement separator in this version/i.test(text) ||
    /Missing file specification after redirection operator/i.test(text) ||
    /The '<' operator is reserved for future use/i.test(text) ||
    /The 'from' keyword is not supported in this version of the language/i.test(text) ||
    /Missing expression after ','/i.test(text) ||
    /Unexpected token 'encoding='utf-8'' in expression or statement/i.test(text) ||
    /Missing closing '\)' in expression/i.test(text) ||
    /^At line:\d+\s+char:\d+/i.test(text) ||
    /^\+\s+~+/i.test(text) ||
    /^['"`].*operator\./i.test(text) ||
    /FullyQualifiedErrorId\s*:\s*InvalidEndOfLine/i.test(text) ||
    /CategoryInfo\s*:\s*ParserError/i.test(text)
  ) {
    return {
      kind: "powershell_parser_nonfatal",
      dedupeKey: "powershell_parser_nonfatal",
      display: `${C.dim}[tool] Codex generated Unix-style shell syntax for PowerShell; the command failed before running${C.reset}`,
    };
  }
  if (/codex_core::tools::router: error=/i.test(text)) {
    const exitMatch = text.match(/exit[_ ]code["=: ]+(\d+)/i);
    const exitCode = exitMatch ? exitMatch[1] : null;
    return {
      kind: "tool_router_nonfatal",
      dedupeKey: "tool_router_nonfatal",
      display: `${C.dim}[tool] Codex internal command returned non-zero${exitCode ? ` (exit ${exitCode})` : ""}; agent may continue${C.reset}`,
    };
  }
  if (
    /codex_core::plugins::startup_sync/i.test(text) ||
    /codex_core::plugins::manager: failed to warm featured plugin ids cache/i.test(text) ||
    /codex_core::plugins::manifest: ignoring interface\.defaultPrompt/i.test(text) ||
    /codex_protocol::openai_models: Model personality requested/i.test(text) ||
    /codex_core::shell_snapshot: Failed to create shell snapshot for powershell/i.test(text)
  ) {
    return { kind: "noise", dedupeKey: "noise", display: null };
  }
  return {
    kind: "stderr_nonfatal",
    dedupeKey: "codex_stderr_nonfatal",
    display: `${C.dim}[tool] Codex emitted shell/tool stderr; details suppressed${C.reset}`,
  };
}

export function __testBuildShellDisciplineBlock({ platform = process.platform, atlasAttachment = null } = {}) {
  const atlasLabel = atlasBackendLabel(atlasAttachment);
  const rules = [
    "CODEX TOOL DISCIPLINE:",
    atlasAttachment?.active
      ? `- ${atlasLabel} is active. Use ${atlasLabel} retrieval tools before deterministic file/search tools for discovery, codebase understanding, and line-level inspection; use deterministic tools only when ${atlasLabel} is unavailable or insufficient, you have mutated files and need current worktree state, or git/test/build/shell operations are required.`
      : "- Deterministic MCP file tools are the default path for exact repo inspection and mutation.",
    `- Use the exact deterministic MCP tool names listed in the Runtime Capability Manifest. In Codex they may be prefixed like ${CODEX_EDIT_FILE_EXAMPLE}; call that exact visible name, not apply_patch or a bare canonical label.`,
    "- Canonical tool labels describe purpose only: read_file for file contents, list_files for directory traversal, search_files for content search, write_file and edit_file for mutations. The callable name is the Available tools name.",
    "- Do NOT use apply_patch or shell for file writes. The sandbox is read-only; the manifest entries whose canonical labels are write_file and edit_file are the only write paths that succeed, including for files outside the working directory that are in your create_roots scope.",
    "- Do NOT use shell for normal file reads, searches, listings, diffs, or edits when a file tool can do the job.",
    "- Shell is an exception path only. Use it only for explicit test/build commands, toolchain commands required by the task, or command output the task specifically asks for.",
    "- If a file read is truncated, read a narrower slice yourself instead of switching to shell or asking the human to paste file contents.",
    "- Never ask the human to paste the contents of a file that exists inside the working directory or an allowed added directory.",
  ];

  if (platform !== "win32") {
    return rules.join("\n");
  }

  return [
    ...rules,
    "",
    "WINDOWS SHELL RULES:",
    "- The shell is Windows PowerShell, not bash.",
    "- Do not assume repo-root-relative paths are valid; use the current working directory or absolute paths.",
    "- Do NOT use bash heredocs like <<'PY' or <<EOF.",
    "- Do NOT use bash chaining/operators like && or || when composing commands.",
    "- Do NOT use Unix-only filters like head or wc; use file tools first, or PowerShell commands such as Select-Object and Measure-Object when shell is truly needed.",
    "- Do NOT use rg, grep, or findstr for routine repository search on Windows. Use the manifest entries whose canonical labels are search_files/list_files instead.",
    "- Before using Python or shell to read a file, verify the file path with the manifest entry whose canonical label is read_file first.",
    "- For multiple PowerShell statements, use separate commands or PowerShell syntax.",
    "- For inline Python, use a PowerShell here-string piped to python, for example:",
    "  @'",
    "  print(\"hello\")",
    "  '@ | python -",
    "- Never use shell just to read or edit repo files when the native tools can do it.",
  ].join("\n");
}

const CODEX_ROLE_GUARD_BLOCKS = {
  dev: [
    "DEV TOOL PRIORITY:",
    `- Use the manifest entries whose canonical labels are write_file and edit_file for file changes. In Codex the callable names may be prefixed like ${CODEX_EDIT_FILE_EXAMPLE}.`,
    "- Do NOT use apply_patch — the sandbox is read-only and apply_patch will be rejected.",
    "- If writable file scope is listed, do not report that no writable file-edit tool exists before trying the exact manifest write/edit tool names and reporting the actual tool error, if any.",
    "- Use the active retrieval context first when it is available; then use the manifest entries whose canonical labels are read_file, list_files, and search_files for exact worktree inspection before editing.",
    "- For files in your create_roots scope that live outside the working directory (e.g. resources/artifacts paths), the manifest entry whose canonical label is write_file still succeeds — it runs outside the Codex sandbox.",
    "- If a test_command is provided, run that command after the file changes are complete.",
    "- For lint/typecheck, including PHP syntax checks, use the manifest entry whose canonical label is run_scoped_checks before considering shell.",
    "- Do not use shell for ad-hoc repository discovery when ATLAS or the manifest file/search tools can answer the question.",
    "- Do not use shell for lint/typecheck commands unless run_scoped_checks reports that the needed check is unavailable or cannot cover the scope; state that reason when falling back.",
  ].join("\n"),
  assessor: [
    "ASSESSOR TOOL PRIORITY:",
    "- Verify files with the manifest entries whose canonical labels are read_file, list_files, and search_files before using shell; when retrieval evidence is active, start there first.",
    "- Use the manifest entry whose canonical label is run_scoped_checks for lint/typecheck first, including PHP syntax checks.",
    "- Use shell only for explicit verification commands such as the provided test command or a narrow project test/build command.",
    "- Do not use shell for lint/typecheck commands unless run_scoped_checks reports that the needed check is unavailable or cannot cover the scope; state that reason when falling back.",
    "- Do not use shell-based search to decide whether the implementation changed the right files.",
  ].join("\n"),
  artificer: [
    "ARTIFICER TOOL PRIORITY:",
    "- Use the manifest entry whose canonical label is write_file for artifacts you create and the entries whose canonical labels are read_file and list_files to inspect inputs.",
    "- Avoid shell for routine filesystem operations when the file tools can perform them directly.",
  ].join("\n"),
};

export function __testBuildCodexRoleGuardBlock({ role = "planner", allowWrite = false } = {}) {
  return CODEX_ROLE_GUARD_BLOCKS[role]
    || (allowWrite
      ? "Use native file tools before shell whenever the task involves repository files."
      : "Prefer native file tools for repository inspection and verification.");
}

function buildCodexWebToolsOverrides({ role, roleMode = null, webToolsEnabled } = {}) {
  const normalizedRoleMode = String(roleMode || "").trim().toLowerCase();
  const webToolsAllowedForRoleMode = !(role === "researcher" && normalizedRoleMode === "synth");
  const active = !!webToolsEnabled && webToolsAllowedForRoleMode && WEB_TOOL_ROLES.has(role);
  return {
    active,
    configOverrides: active ? ["tools.web_search=true"] : [],
  };
}

export function __testBuildCodexWebToolsOverrides(options = {}) {
  return buildCodexWebToolsOverrides(options);
}

function buildCodexWebToolsNote(role) {
  if (role === "researcher") {
    return "WEB RESEARCH: The Codex `web_search` tool is enabled. Use it to gather external documentation, specs, or current facts when the repo does not already contain them. Cite URLs in the research brief.";
  }
  if (role === "artificer") {
    return "WEB RESEARCH: The Codex `web_search` tool is enabled. Use it only to gather external references needed for artifact content. Do not use native/system file tools; use deterministic MCP tools for files and images.";
  }
  return null;
}

let CODEX_CMD = null;
let CODEX_ARGS = [];
let CODEX_RESOLVE_ERROR = null;
const CODEX_REQUIRED_EXEC_FLAGS = [
  "--json",
  "--output-last-message",
  "--skip-git-repo-check",
  "--ignore-rules",
  "--config",
];

function splitPathEntries(pathValue) {
  return String(pathValue || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getWindowsEnvPath() {
  return process.env.PATH || process.env.Path || "";
}

function isProtectedWindowsAppCodexPath(candidate) {
  const normalized = String(candidate || "").replace(/\//g, "\\").toLowerCase();
  return normalized.includes("\\windowsapps\\openai.codex_")
    && normalized.includes("\\app\\resources\\codex");
}

function resolveWindowsPathCommand(commandBase, envPath = getWindowsEnvPath()) {
  const preferredExts = [".exe", ".cmd", ".bat", ""];
  for (const dir of splitPathEntries(envPath)) {
    for (const ext of preferredExts) {
      const candidate = path.join(dir, `${commandBase}${ext}`);
      try {
        if (fs.existsSync(candidate) && !isProtectedWindowsAppCodexPath(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore unreadable PATH entries and keep searching.
      }
    }
  }
  return null;
}

function isBareCommand(cmd) {
  if (!cmd) return true;
  if (path.isAbsolute(cmd)) return false;
  return !cmd.includes("\\") && !cmd.includes("/");
}

function sanitizeLaunchArg(arg) {
  const value = String(arg == null ? "" : arg);
  if (!value) return value;
  if (/mcp_servers\.[^.]+\.env\.[^=]+=/.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/(api[_-]?key|token|secret|password)/iu.test(value)) {
    if (value.includes("=")) return value.replace(/=.*/u, "=<redacted>");
    return "<redacted-arg>";
  }
  return value;
}

function formatSpawnLaunchForError(launch) {
  const safeArgs = Array.isArray(launch?.args) ? launch.args.map((arg) => sanitizeLaunchArg(arg)) : [];
  return `${launch?.command || "codex"} ${safeArgs.join(" ")}`.trim();
}

function findWindowsAppCodex() {
  const baseDir = "C:\\Program Files\\WindowsApps";
  try {
    const dirs = fs.readdirSync(baseDir)
      .filter((name) => /^OpenAI\.Codex_/i.test(name))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const exePath = path.join(baseDir, dir, "app", "resources", "codex.exe");
      if (fs.existsSync(exePath) && !isProtectedWindowsAppCodexPath(exePath)) return exePath;
    }
  } catch {
    // Ignore lookup failures; caller falls back to PATH.
  }
  return null;
}

function spawnProbeAsync(command, args, options = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child?.kill?.("SIGTERM"); } catch {}
      finish({ status: null, signal: "SIGTERM", error: new Error("timeout") });
    }, Math.max(1000, Number(timeoutMs) || 3000));
    timer.unref?.();
    try {
      child = spawn(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => finish({ status: null, signal: null, error }));
      child.on("exit", (status, signal) => finish({ status, signal: signal || null, error: null }));
    } catch (error) {
      finish({ status: null, signal: null, error });
    }
  });
}

function isExecutableCodexCli(exePath, spawnSyncImpl = spawnSync) {
  const target = String(exePath || "");
  if (!target) return false;
  try {
    const launch = buildWindowsSpawn(target, ["--version"]);
    const result = spawnSyncImpl(launch.command, launch.args, {
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result && result.status === 0;
  } catch {
    return false;
  }
}

function probeCodexCli(exePath, spawnSyncImpl = spawnSync) {
  const target = String(exePath || "").trim();
  if (!target) return { ok: false, path: target, reason: "empty path", missingFlags: [] };
  if (isProtectedWindowsAppCodexPath(target)) {
    return { ok: false, path: target, reason: "protected WindowsApps resource binary", missingFlags: [] };
  }
  if (!isExecutableCodexCli(target, spawnSyncImpl)) {
    return { ok: false, path: target, reason: "codex --version failed", missingFlags: [] };
  }
  try {
    const launch = buildWindowsSpawn(target, ["exec", "resume", "--help"]);
    const result = spawnSyncImpl(launch.command, launch.args, {
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result || result.status !== 0) {
      return { ok: false, path: target, reason: "codex exec resume --help failed", missingFlags: [] };
    }
    const help = `${result.stdout || ""}\n${result.stderr || ""}`;
    const missingFlags = CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => !help.includes(flag));
    if (missingFlags.length > 0) {
      return { ok: false, path: target, reason: `missing required flags: ${missingFlags.join(", ")}`, missingFlags };
    }
    return { ok: true, path: target, reason: null, missingFlags: [] };
  } catch (err) {
    return { ok: false, path: target, reason: err?.message || "probe failed", missingFlags: [] };
  }
}

function codexCliSupportsExecContract(exePath, spawnSyncImpl = spawnSync) {
  return probeCodexCli(exePath, spawnSyncImpl).ok;
}

function getCodexConfiguredPath() {
  const configuredPath = readModelSetting("codex_cli_path");
  if (!configuredPath || isProtectedWindowsAppCodexPath(configuredPath)) return null;
  try {
    return fs.existsSync(configuredPath) ? configuredPath : null;
  } catch {
    return null;
  }
}

function getCodexCandidatePaths() {
  const extraPaths = [];
  const configuredPath = getCodexConfiguredPath();
  if (configuredPath) extraPaths.push(configuredPath);
  if (process.platform === "win32") {
    extraPaths.push(path.join(os.homedir(), ".codex", ".sandbox-bin", "codex.exe"));
    const appExe = findWindowsAppCodex();
    if (appExe) extraPaths.push(appExe);
  }
  return discoverCommandCandidates("codex", {
    extraPaths,
    protectedPath: isProtectedWindowsAppCodexPath,
  });
}

function chooseCodexCandidate(spawnSyncImpl = spawnSync) {
  const checked = [];
  for (const candidate of getCodexCandidatePaths()) {
    const probe = probeCodexCli(candidate, spawnSyncImpl);
    checked.push(probe);
    if (probe.ok) return { selected: candidate, checked };
  }
  return { selected: null, checked };
}

function formatCodexResolveError(checked = []) {
  const base = "Codex CLI not found with required `codex exec resume` contract flags. Install or update @openai/codex.";
  const failed = checked
    .filter((entry) => entry?.path)
    .slice(0, 6)
    .map((entry) => `${entry.path} (${entry.reason || "rejected"})`);
  return failed.length > 0 ? `${base} Checked: ${failed.join("; ")}` : base;
}

export function discoverCodexCli() {
  const result = chooseCodexCandidate();
  return {
    provider: "codex",
    settingKey: "codex_cli_path",
    selected: result.selected,
    candidates: result.checked.map((entry) => entry.path),
    checked: result.checked,
    ready: !!result.selected,
    reason: result.selected ? null : formatCodexResolveError(result.checked),
  };
}
function resolveCodex() {
  const result = chooseCodexCandidate();
  if (result.selected) {
    CODEX_RESOLVE_ERROR = null;
    CODEX_CMD = result.selected;
    CODEX_ARGS = [];
    return;
  }
  CODEX_RESOLVE_ERROR = formatCodexResolveError(result.checked);
  CODEX_CMD = null;
  CODEX_ARGS = [];
}
function ensureCodexResolved() {
  if (!CODEX_CMD || (process.platform === "win32" && isBareCommand(CODEX_CMD))) {
    resolveCodex();
  }
}

async function resolveCodexAsync() {
  const result = await chooseCodexCandidateAsync();
  if (result.selected) {
    CODEX_RESOLVE_ERROR = null;
    CODEX_CMD = result.selected;
    CODEX_ARGS = [];
    return;
  }
  CODEX_RESOLVE_ERROR = formatCodexResolveError(result.checked);
  CODEX_CMD = null;
  CODEX_ARGS = [];
}
async function ensureCodexResolvedAsync() {
  if (!CODEX_CMD || (process.platform === "win32" && isBareCommand(CODEX_CMD))) {
    await resolveCodexAsync();
  }
}

export function getClaudeInfo() {
  ensureCodexResolved();
  return { cmd: CODEX_CMD, args: CODEX_ARGS };
}

export function __testResolveWindowsPathCommand(commandBase, envPath) {
  return resolveWindowsPathCommand(commandBase, envPath);
}

export function __testIsProtectedWindowsAppCodexPath(candidate) {
  return isProtectedWindowsAppCodexPath(candidate);
}

export function __testIsExecutableCodexCli(exePath, spawnSyncImpl) {
  return isExecutableCodexCli(exePath, spawnSyncImpl);
}

export function __testCodexCliSupportsExecContract(exePath, spawnSyncImpl) {
  return codexCliSupportsExecContract(exePath, spawnSyncImpl);
}

function getAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function hasCodexLoginAuth() {
  return fs.existsSync(getAuthPath());
}

function hasCodexApiAuth() {
  return !!process.env.CODEX_API_KEY || !!process.env.OPENAI_API_KEY;
}

function normalizeConfiguredAuthMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "oauth";
  if (raw === "oauth" || raw === "login") return "oauth";
  if (raw === "api" || raw === "api_key" || raw === "apikey") return "api";
  if (raw === "auto") return "auto";
  return "oauth";
}

function getConfiguredCodexAuthMode() {
  return normalizeConfiguredAuthMode(
    readModelSetting("codex_auth_mode")
      || "oauth"
  );
}

function resolveCodexAuthModeInternal({
  configuredMode = "auto",
  loginAvailable = hasCodexLoginAuth(),
  apiAvailable = hasCodexApiAuth(),
} = {}) {
  const mode = normalizeConfiguredAuthMode(configuredMode);
  if (mode === "oauth") {
    if (!loginAvailable) {
      return {
        ok: false,
        configuredMode: mode,
        mode: "oauth",
        reason: "Codex auth mode is oauth but ~/.codex/auth.json was not found. Run `codex login`. API-key auth is disabled unless codex_auth_mode is explicitly api.",
      };
    }
    return { ok: true, configuredMode: mode, mode: "oauth", reason: null };
  }
  if (mode === "api") {
    if (!apiAvailable) {
      return {
        ok: false,
        configuredMode: mode,
        mode: "api",
        reason: "Codex auth mode is api but CODEX_API_KEY/OPENAI_API_KEY is not set.",
      };
    }
    return { ok: true, configuredMode: mode, mode: "api", reason: null };
  }

  if (loginAvailable) return { ok: true, configuredMode: mode, mode: "oauth", reason: null };
  return {
    ok: false,
    configuredMode: mode,
    mode: "oauth",
    reason: "Codex auth mode is auto but ~/.codex/auth.json was not found. Run `codex login`. API keys are only used when codex_auth_mode is explicitly api.",
  };
}

function getPreferredCodexAuthMode() {
  return resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() }).mode;
}

export function hasCredentials() {
  return resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() }).ok;
}

export function __testResolveCodexAuthMode(configuredMode, loginAvailable, apiAvailable) {
  return resolveCodexAuthModeInternal({ configuredMode, loginAvailable, apiAvailable });
}

export function isReady() {
  ensureCodexResolved();
  const hasBinary = !!CODEX_CMD;
  if (!hasBinary) return { ready: false, reason: CODEX_RESOLVE_ERROR || "Codex CLI not found on PATH" };
  const auth = resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() });
  if (!auth.ok) return { ready: false, reason: auth.reason };
  return { ready: true, reason: null };
}

export async function isReadyAsync() {
  await ensureCodexResolvedAsync();
  const hasBinary = !!CODEX_CMD;
  if (!hasBinary) return { ready: false, reason: CODEX_RESOLVE_ERROR || "Codex CLI not found on PATH" };
  const auth = resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() });
  if (!auth.ok) return { ready: false, reason: auth.reason };
  return { ready: true, reason: null };
}

function readCodexLimitSetting(key) {
  try {
    const stored = getSetting(key);
    if (stored != null && String(stored).trim() !== "") {
      const parsed = parseInt(String(stored).trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Ignore DB-read failures and fall back to null.
  }
  return null;
}

function getCodexUsageLimits() {
  return {
    session: readCodexLimitSetting("codex_limit_tokens_session"),
    week: readCodexLimitSetting("codex_limit_tokens_week"),
  };
}

function buildCodexLocalUsageSummary(nowMs = Date.now(), detail = null) {
  const entries = loadUsageEntries({
    nowMs,
    windowDefs: CODEX_USAGE_WINDOW_DEFS,
    provider: "codex",
    normalizeProvider: true,
  });
  const localUsedTokens = entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0);
  return {
    provider: "codex",
    source: "posse-agent-calls",
    subscriptionType: null,
    rateLimitTier: null,
    localUsedTokens,
    windows: summarizeUsageEntries(entries, nowMs, getCodexUsageLimits(), CODEX_USAGE_WINDOW_DEFS),
    detail: detail ? String(detail) : null,
  };
}

function cloneUsageSummary(summary) {
  return {
    ...summary,
    windows: Array.isArray(summary?.windows) ? summary.windows.map((window) => ({ ...window })) : [],
    credits: summary?.credits && typeof summary.credits === "object" ? { ...summary.credits } : summary?.credits,
  };
}

function clampPercent(value) {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

const CODEX_STATUS_MONTHS = new Map([
  ["jan", 0], ["january", 0],
  ["feb", 1], ["february", 1],
  ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3],
  ["may", 4],
  ["jun", 5], ["june", 5],
  ["jul", 6], ["july", 6],
  ["aug", 7], ["august", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["october", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["december", 11],
]);

function parseCodexStatusResetAt(fragment, nowMs = Date.now()) {
  const text = String(fragment || "").trim().replace(/^resets\s+/i, "");
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]+))?/i);
  if (!match) return null;
  const now = new Date(nowMs);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute > 59) return null;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (match[3] && match[4]) {
    const month = CODEX_STATUS_MONTHS.get(match[4].toLowerCase());
    const day = Number(match[3]);
    if (month == null || !Number.isInteger(day) || day < 1 || day > 31) return null;
    candidate.setMonth(month, day);
    if (candidate.getTime() < nowMs - 24 * 60 * 60 * 1000) {
      candidate.setFullYear(candidate.getFullYear() + 1);
    }
  } else if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate.toISOString();
}

function normalizeCodexLimitKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseCodexStatusText(text, nowMs = Date.now()) {
  const clean = stripTerminalControls(text);
  const parsed = {
    account: null,
    accountPlan: null,
    sessionId: null,
    credits: null,
    windows: [],
  };
  let sectionName = null;

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line) continue;

    const accountMatch = line.match(/^Account:\s*(.+?)(?:\s+\(([^)]+)\))?$/i);
    if (accountMatch) {
      parsed.account = accountMatch[1].trim() || null;
      parsed.accountPlan = accountMatch[2]?.trim() || null;
      sectionName = null;
      continue;
    }

    const sessionMatch = line.match(/^Session:\s*(.+)$/i);
    if (sessionMatch) {
      parsed.sessionId = sessionMatch[1].trim() || null;
      continue;
    }

    const creditsMatch = line.match(/^Credits:\s*([0-9][0-9,]*(?:\.\d+)?)\s*credits?/i);
    if (creditsMatch) {
      parsed.credits = {
        hasCredits: true,
        unlimited: false,
        balance: Number(creditsMatch[1].replace(/,/g, "")),
      };
      continue;
    }

    if (/^Credits:\s*unlimited/i.test(line)) {
      parsed.credits = {
        hasCredits: true,
        unlimited: true,
        balance: null,
      };
      continue;
    }

    const sectionMatch = line.match(/^(.+?)\s+limit:\s*$/i);
    if (sectionMatch && !/^(?:5h|weekly)\s+limit/i.test(line)) {
      sectionName = sectionMatch[1].trim();
      continue;
    }

    const windowMatch = line.match(/^(5h|Weekly)\s+limit:\s*(?:\[[^\]]*\]\s*)?([0-9]+(?:\.[0-9]+)?)%\s+left(?:\s*\(([^)]*)\))?/i);
    if (!windowMatch) continue;

    const baseKey = /^5h$/i.test(windowMatch[1]) ? "session" : "week";
    const remainingPct = clampPercent(windowMatch[2]);
    if (remainingPct == null) continue;
    const sectionKey = normalizeCodexLimitKey(sectionName || "codex");
    const isDefaultSection = !sectionName || sectionKey === "codex";
    const key = isDefaultSection ? baseKey : `${sectionKey}_${baseKey}`;
    const labelPrefix = isDefaultSection ? "" : `${sectionName} `;
    parsed.windows.push({
      key,
      label: `${labelPrefix}${baseKey === "session" ? "Session (5h)" : "Week (7d)"}`,
      durationMs: baseKey === "session" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
      utilizationPct: Math.max(0, 100 - remainingPct),
      usageUnit: "percent",
      usedTokens: null,
      limitTokens: null,
      remainingTokens: null,
      remainingPct,
      exhausted: remainingPct <= 0,
      resetAt: parseCodexStatusResetAt(windowMatch[3], nowMs),
      limitId: isDefaultSection ? "codex" : sectionName,
    });
  }

  return parsed;
}

function normalizeCodexStatusSummary(parsed, nowMs = Date.now()) {
  const local = buildCodexLocalUsageSummary(nowMs);
  return {
    provider: "codex",
    source: "codex-cli-status",
    subscriptionType: parsed?.accountPlan || null,
    rateLimitTier: null,
    account: parsed?.account || null,
    sessionId: parsed?.sessionId || null,
    credits: parsed?.credits || null,
    localUsedTokens: local.localUsedTokens || 0,
    windows: Array.isArray(parsed?.windows) ? parsed.windows.map((window) => ({ ...window })) : [],
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function readRateLimitField(obj, camelKey, snakeKey = null) {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[camelKey] !== undefined) return obj[camelKey];
  if (snakeKey && obj[snakeKey] !== undefined) return obj[snakeKey];
  return undefined;
}

function formatCodexWindowLabel(baseKey, durationMins, limitLabel = null) {
  const prefix = limitLabel ? `${limitLabel} ` : "";
  if (baseKey === "session") {
    if (durationMins === 300) return `${prefix}Session (5h)`;
    if (durationMins === 60) return `${prefix}Session (1h)`;
    if (Number.isFinite(durationMins) && durationMins > 0) return `${prefix}Session (${durationMins}m)`;
    return `${prefix}Session`;
  }
  if (durationMins === 10080) return `${prefix}Week (7d)`;
  if (durationMins === 1440) return `${prefix}Week (1d)`;
  if (Number.isFinite(durationMins) && durationMins > 0) return `${prefix}Week (${durationMins}m)`;
  return `${prefix}Week`;
}

function normalizeCodexRateLimitWindow(rawWindow, {
  key,
  baseKey,
  limitId = "codex",
  limitLabel = null,
} = {}) {
  if (!rawWindow || typeof rawWindow !== "object") return null;
  const usedPct = clampPercent(readRateLimitField(rawWindow, "usedPercent", "used_percent"));
  if (usedPct == null) return null;
  const durationMinsRaw = readRateLimitField(rawWindow, "windowDurationMins", "window_duration_mins");
  const durationMins = Number(durationMinsRaw);
  const resetSeconds = readRateLimitField(rawWindow, "resetsAt", "resets_at");
  return {
    key,
    label: formatCodexWindowLabel(baseKey, Number.isFinite(durationMins) ? durationMins : null, limitLabel),
    durationMs: Number.isFinite(durationMins) && durationMins > 0 ? durationMins * 60 * 1000 : null,
    utilizationPct: usedPct,
    usageUnit: "percent",
    usedTokens: null,
    limitTokens: null,
    remainingTokens: null,
    remainingPct: Math.max(0, 100 - usedPct),
    exhausted: usedPct >= 100,
    resetAt: unixSecondsToIso(resetSeconds),
    limitId,
  };
}

function normalizeCodexCredits(rawCredits) {
  if (!rawCredits || typeof rawCredits !== "object") return null;
  const hasCredits = readRateLimitField(rawCredits, "hasCredits", "has_credits");
  const unlimited = readRateLimitField(rawCredits, "unlimited");
  const balance = readRateLimitField(rawCredits, "balance");
  return {
    hasCredits: hasCredits == null ? null : !!hasCredits,
    unlimited: unlimited == null ? null : !!unlimited,
    balance: balance == null || balance === "" ? null : Number(balance),
  };
}

function normalizeCodexRateLimitSnapshot(snapshot, {
  baseKeyPrefix = "",
  limitLabel = null,
} = {}) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const limitId = String(
    readRateLimitField(snapshot, "limitId", "limit_id")
      || readRateLimitField(snapshot, "limitName", "limit_name")
      || limitLabel
      || "codex"
  );
  const keyPrefix = baseKeyPrefix ? `${normalizeCodexLimitKey(baseKeyPrefix)}_` : "";
  return [
    normalizeCodexRateLimitWindow(readRateLimitField(snapshot, "primary"), {
      key: `${keyPrefix}session`,
      baseKey: "session",
      limitId,
      limitLabel,
    }),
    normalizeCodexRateLimitWindow(readRateLimitField(snapshot, "secondary"), {
      key: `${keyPrefix}week`,
      baseKey: "week",
      limitId,
      limitLabel,
    }),
  ].filter(Boolean);
}

function normalizeCodexRateLimitsResponse(payload, nowMs = Date.now()) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const primarySnapshot = readRateLimitField(raw, "rateLimits", "rate_limits") || {};
  const byLimitId = readRateLimitField(raw, "rateLimitsByLimitId", "rate_limits_by_limit_id") || {};
  const windows = normalizeCodexRateLimitSnapshot(primarySnapshot);
  const primaryLimitId = String(readRateLimitField(primarySnapshot, "limitId", "limit_id") || "codex");

  if (byLimitId && typeof byLimitId === "object") {
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const snapshotLimitId = String(readRateLimitField(snapshot, "limitId", "limit_id") || limitId || "");
      if (snapshotLimitId === primaryLimitId || (snapshotLimitId === "codex" && primaryLimitId === "codex")) continue;
      const limitName = String(readRateLimitField(snapshot, "limitName", "limit_name") || snapshotLimitId || limitId);
      windows.push(...normalizeCodexRateLimitSnapshot(snapshot, {
        baseKeyPrefix: snapshotLimitId || limitId,
        limitLabel: limitName,
      }));
    }
  }

  const credits = normalizeCodexCredits(readRateLimitField(primarySnapshot, "credits"));
  const local = buildCodexLocalUsageSummary(nowMs);
  return {
    provider: "codex",
    source: "codex-app-server-rate-limits",
    subscriptionType: readRateLimitField(primarySnapshot, "planType", "plan_type") || null,
    rateLimitTier: null,
    credits,
    rateLimitReachedType: readRateLimitField(primarySnapshot, "rateLimitReachedType", "rate_limit_reached_type") || null,
    localUsedTokens: local.localUsedTokens || 0,
    windows,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

function getCachedCodexUsageSummary(nowMs, { forceRefresh = false, ignoreBackoff = false } = {}) {
  if (!_usageSummaryCache?.summary) return null;
  const cacheInBackoff = _usageSummaryCache.nextRetryAt && nowMs < _usageSummaryCache.nextRetryAt;
  if ((cacheInBackoff && !ignoreBackoff) || (!forceRefresh && nowMs - _usageSummaryCache.cachedAt <= codexUsageCacheMs())) {
    return cloneUsageSummary(_usageSummaryCache.summary);
  }
  return null;
}

function firstErrorLine(err) {
  return String(err?.message || err || "unknown").split("\n")[0].trim();
}

function markInteractiveUsageUnavailable(err) {
  const reason = firstErrorLine(err);
  if (_interactiveUsageUnavailableReason) return;
  _interactiveUsageUnavailableReason = reason || "interactive usage probe failed";
  log.warn("provider", "Codex interactive usage probe unavailable; falling back to app-server", {
    error: _interactiveUsageUnavailableReason,
  });
}

function shouldSkipInteractiveUsage({ allowInteractiveOnWindows = false, platform = process.platform } = {}) {
  if (_interactiveUsageUnavailableReason) return _interactiveUsageUnavailableReason;
  if (platform === "win32" && !allowInteractiveOnWindows) {
    markInteractiveUsageUnavailable("disabled on Windows because node-pty ConPTY attach can block provider usage refresh");
    return _interactiveUsageUnavailableReason;
  }
  return null;
}

async function fetchCodexStatusViaInteractive({
  cwd = null,
  timeoutMs = 8_000,
  backend = null,
} = {}) {
  await ensureCodexResolvedAsync();
  if (!CODEX_CMD) throw new Error(CODEX_RESOLVE_ERROR || "Codex CLI not found");
  const resolvedBackend = backend || getDefaultInteractiveCliBackend();
  if (!resolvedBackend) throw new InteractiveCliUnavailableError();

  const args = [
    ...CODEX_ARGS,
    "--no-alt-screen",
    "--ask-for-approval", "never",
    "--sandbox", "read-only",
  ];
  if (cwd) args.push("--cd", cwd);
  const launch = buildWindowsSpawn(CODEX_CMD, args);
  const session = new InteractiveCliSession({
    command: launch.command,
    args: launch.args,
    cwd: cwd || process.cwd(),
    env: process.env,
    backend: resolvedBackend,
    timeoutMs,
    quietMs: 500,
    cols: 120,
    rows: 40,
  });

  try {
    session.start();
    await session.waitForQuiet({ quietMs: 300, timeoutMs: Math.min(timeoutMs, 2_000) }).catch(() => {});
    session.sendLine("/status");
    await session.waitFor(
      (output) => /(?:5h|Weekly)\s+limit:|Credits:/i.test(stripTerminalControls(output)),
      { timeoutMs }
    );
    await session.waitForQuiet({ quietMs: 600, timeoutMs: Math.min(timeoutMs, 3_000) }).catch(() => {});
    session.sendLine("/quit");
    return session.cleanTranscript();
  } finally {
    await session.close({ gracefulMs: 500 });
  }
}

async function fetchCodexRateLimitsViaAppServer({
  cwd = null,
  timeoutMs = 8_000,
} = {}) {
  await ensureCodexResolvedAsync();
  if (!CODEX_CMD) throw new Error(CODEX_RESOLVE_ERROR || "Codex CLI not found");
  const launch = buildWindowsSpawn(CODEX_CMD, [...CODEX_ARGS, "app-server", "--listen", "stdio://"]);
  const resolvedTimeoutMs = Math.max(1_000, Number(timeoutMs) || 8_000);

  return await new Promise((resolve, reject) => {
    let proc;
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let nextId = 1;
    let initializeId = null;
    let rateLimitsId = null;

    const finish = (err, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc) terminateSpawnedProcess(proc, { force: process.platform === "win32" });
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Codex app-server rate-limit request timed out after ${resolvedTimeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`));
    }, resolvedTimeoutMs);
    timer.unref?.();

    const writeMessage = (message) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const sendRequest = (method, params = undefined) => {
      const id = nextId++;
      const message = { id, method };
      if (params !== undefined) message.params = params;
      writeMessage(message);
      return id;
    };

    const handleMessage = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.id === initializeId) {
        if (message.error) {
          finish(new Error(`Codex app-server initialize failed: ${message.error?.message || JSON.stringify(message.error)}`));
          return;
        }
        writeMessage({ method: "notifications/initialized" });
        rateLimitsId = sendRequest("account/rateLimits/read");
        return;
      }

      if (message.id === rateLimitsId) {
        if (message.error) {
          finish(new Error(`Codex app-server rate-limit read failed: ${message.error?.message || JSON.stringify(message.error)}`));
          return;
        }
        finish(null, message.result || {});
      }
    };

    try {
      proc = spawn(launch.command, launch.args, {
        cwd: cwd || process.cwd(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (err) {
      finish(err);
      return;
    }

    proc.stdin.on("error", () => {});
    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // Ignore non-JSON startup noise; stderr is retained for failures.
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => finish(err));
    proc.on("close", (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before rate-limit response (exit ${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    initializeId = sendRequest("initialize", {
      clientInfo: {
        name: "posse",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });
}

export async function refreshUsageSummary({
  nowMs = Date.now(),
  forceRefresh = false,
  ignoreBackoff = false,
  timeoutMs = 8_000,
  cwd = null,
  interactiveBackend = null,
  preferInteractive = false,
  allowInteractiveOnWindows = false,
  platform = process.platform,
} = {}) {
  const cached = getCachedCodexUsageSummary(nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  const errors = [];
  const interactiveSkipReason = preferInteractive
    ? shouldSkipInteractiveUsage({ allowInteractiveOnWindows, platform })
    : null;
  if (preferInteractive && !interactiveSkipReason) {
    try {
      const fetchInteractive = _testFetchCodexStatusViaInteractive || fetchCodexStatusViaInteractive;
      const needsBackend = fetchInteractive === fetchCodexStatusViaInteractive;
      const backend = interactiveBackend || (needsBackend ? getDefaultInteractiveCliBackend() : null);
      if (needsBackend && !backend) throw new InteractiveCliUnavailableError();
      const transcript = await fetchInteractive({ cwd, timeoutMs, backend });
      const summary = normalizeCodexStatusSummary(parseCodexStatusText(transcript, nowMs), nowMs);
      _usageSummaryCache = { cachedAt: nowMs, nextRetryAt: 0, summary };
      return cloneUsageSummary(summary);
    } catch (err) {
      markInteractiveUsageUnavailable(err);
      errors.push(err);
    }
  } else if (preferInteractive && interactiveSkipReason) {
    errors.push(new InteractiveCliUnavailableError(`Codex interactive usage probe disabled: ${interactiveSkipReason}`));
  }

  try {
    const fetchAppServer = _testFetchCodexRateLimitsViaAppServer || fetchCodexRateLimitsViaAppServer;
    const payload = await fetchAppServer({ cwd, timeoutMs });
    const summary = normalizeCodexRateLimitsResponse(payload, nowMs);
    _usageSummaryCache = { cachedAt: nowMs, nextRetryAt: 0, summary };
    return cloneUsageSummary(summary);
  } catch (err) {
    errors.push(err);
  }

  const stale = _usageSummaryCache?.summary
    ? {
        ..._usageSummaryCache.summary,
        stale: true,
        source: "codex-rate-limits-unavailable",
        detail: errors.map((err) => String(err?.message || err)).filter(Boolean).join("; ") || null,
      }
    : {
        ...buildCodexLocalUsageSummary(nowMs, errors.map((err) => String(err?.message || err)).filter(Boolean).join("; ") || null),
        source: "codex-rate-limits-unavailable",
      };
  _usageSummaryCache = {
    cachedAt: nowMs,
    nextRetryAt: nowMs + codexUsageBackoffMs(),
    summary: stale,
  };
  return cloneUsageSummary(stale);
}

export function getUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false } = {}) {
  const cached = getCachedCodexUsageSummary(nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;
  return buildCodexLocalUsageSummary(nowMs);
}

function makeTempOutputFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-codex-"));
  return {
    dir,
    file: path.join(dir, "last-message.txt"),
  };
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

const CODEX_CONFIG_ARG_SPILL_SINGLE_LIMIT = 6000;
const CODEX_CONFIG_ARG_SPILL_TOTAL_LIMIT = 12000;

function getCodexHomeFromEnv(env = process.env) {
  const configured = String(env?.CODEX_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function shouldSpillCodexConfigOverrides(configOverrides = [], {
  platform = process.platform,
} = {}) {
  if (platform !== "win32") return false;
  const values = (configOverrides || []).map((entry) => String(entry || ""));
  const totalLength = values.reduce((sum, entry) => sum + entry.length, 0);
  return values.some((entry) => entry.length > CODEX_CONFIG_ARG_SPILL_SINGLE_LIMIT)
    || totalLength > CODEX_CONFIG_ARG_SPILL_TOTAL_LIMIT;
}

function bestEffortChmod(filePath, mode) {
  try { fs.chmodSync(filePath, mode); } catch { /* Windows/best-effort */ }
}

function prepareCodexConfigForSpawn(configOverrides = [], {
  env = process.env,
  platform = process.platform,
  tempParent = null,
  authMode = "oauth",
} = {}) {
  const overrides = (configOverrides || []).filter(Boolean).map((entry) => String(entry));
  if (!shouldSpillCodexConfigOverrides(overrides, { platform })) {
    return {
      configOverrides: overrides,
      codexHome: null,
      cleanup: () => {},
      spilled: false,
    };
  }

  const sourceHome = getCodexHomeFromEnv(env);
  const parent = tempParent || path.join(sourceHome, ".posse-run-homes");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  bestEffortChmod(parent, 0o700);
  const codexHome = fs.mkdtempSync(path.join(parent, "codex-"));
  bestEffortChmod(codexHome, 0o700);
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "# Generated by Posse for one Codex provider invocation.",
      "# Large config overrides live here to avoid Windows command-line limits.",
      ...overrides,
      "",
    ].join("\n"),
    "utf8",
  );
  bestEffortChmod(configPath, 0o600);

  const sourceAuth = path.join(sourceHome, "auth.json");
  const targetAuth = path.join(codexHome, "auth.json");
  try {
    if (normalizeConfiguredAuthMode(authMode) === "oauth" && fs.existsSync(sourceAuth)) {
      fs.copyFileSync(sourceAuth, targetAuth);
      bestEffortChmod(targetAuth, 0o600);
    }
  } catch {
    // Provider readiness will surface auth problems; spilling config must not
    // mask the original call path with a best-effort copy failure.
  }

  return {
    configOverrides: [],
    codexHome,
    cleanup: () => cleanupTempDir(codexHome),
    spilled: true,
  };
}

function buildCodexExecArgs({
  outputFile,
  workingDir,
  allowWrite = false,
  modelToUse = null,
  configOverrides = [],
  forceReadOnlySandbox = false,
  priorSessionHandle = null,
} = {}) {
  const sandboxMode = (allowWrite && !forceReadOnlySandbox) ? "workspace-write" : "read-only";
  const resumeHandle = normalizeCodexSessionHandle(priorSessionHandle);
  const args = [
    ...CODEX_ARGS,
    "exec",
    ...(resumeHandle ? ["resume"] : []),
    "--json",
    "--output-last-message", outputFile,
    "--skip-git-repo-check",
    "--ignore-rules",
    // Non-interactive exec: failures return to the model instead of
    // auto-cancelling MCP tool calls as "user cancelled". Sandbox still
    // gates apply_patch/shell writes, so MCP remains the only write path.
    // `codex exec` has no --ask-for-approval flag; use the config override.
    "-c", 'approval_policy="never"',
    "-c", `sandbox_mode=${_toTomlLiteral(sandboxMode)}`,
  ];

  if (!resumeHandle) {
    args.push("--cd", workingDir, "--sandbox", sandboxMode);
  }

  if (modelToUse) {
    args.push("--model", modelToUse);
  }

  for (const override of (configOverrides || [])) {
    if (!override) continue;
    args.push("-c", override);
  }

  if (resumeHandle) {
    args.push(resumeHandle);
  }
  args.push("-");
  return args;
}

export function __testBuildCodexExecArgs(options) {
  return buildCodexExecArgs(options);
}

function isPathInsideOrEqual(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectCodexExtraDirs({
  workingDir,
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  fsImpl = fs,
} = {}) {
  const extraDirs = new Set();
  for (const p of [...(scopedFiles || []), ...(createFiles || []), ...(createRoots || []), ...(readRoots || [])]) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(workingDir, p);
    const dir = fsImpl.existsSync(abs) && fsImpl.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    if (!isPathInsideOrEqual(dir, workingDir)) extraDirs.add(dir);
  }
  return extraDirs;
}

export function __testCollectCodexExtraDirs(options) {
  return [...collectCodexExtraDirs(options)].sort();
}

const CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT = 24000;

function buildCodexDeveloperInstructionRoute({
  promptPrelude = "",
  contractBlock = "",
  stableContext = "",
  atlasNote = null,
  strictMcpNote = null,
  webToolsNote = null,
  shellDiscipline = "",
  roleGuard = "",
} = {}, {
  softLimit = CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT,
} = {}) {
  const hardBlocks = [
    contractBlock,
    atlasNote,
    strictMcpNote,
    webToolsNote,
    shellDiscipline,
    roleGuard,
  ].filter(Boolean);
  const softBlocks = [
    stableContext,
  ].filter(Boolean);
  const strictBlocks = [
    ...hardBlocks,
    ...softBlocks,
  ];
  const fullDeveloperInstructions = [
    promptPrelude,
    ...strictBlocks,
  ].filter(Boolean).join("\n\n");
  if (!fullDeveloperInstructions.trim()) {
    return { configOverride: null, developerInstructions: null, inlinePromptPrelude: null };
  }
  if (fullDeveloperInstructions.length <= softLimit) {
    return {
      configOverride: `developer_instructions=${_toTomlLiteral(fullDeveloperInstructions)}`,
      developerInstructions: fullDeveloperInstructions,
      inlinePromptPrelude: null,
    };
  }

  const strictDeveloperInstructions = strictBlocks.join("\n\n");
  if (strictDeveloperInstructions.length <= softLimit) {
    return {
      configOverride: `developer_instructions=${_toTomlLiteral(strictDeveloperInstructions)}`,
      developerInstructions: strictDeveloperInstructions,
      inlinePromptPrelude: promptPrelude || null,
    };
  }

  // Last resort for Windows argv pressure: keep hard execution policy in
  // developer_instructions, but move only non-contract stable context inline.
  const hardDeveloperInstructions = hardBlocks.join("\n\n");
  const inlinePromptPrelude = [
    promptPrelude,
    ...softBlocks,
  ].filter(Boolean).join("\n\n");
  return {
    configOverride: hardDeveloperInstructions
      ? `developer_instructions=${_toTomlLiteral(hardDeveloperInstructions)}`
      : null,
    developerInstructions: hardDeveloperInstructions || null,
    inlinePromptPrelude: inlinePromptPrelude || null,
  };
}

export function __testBuildCodexDeveloperInstructionRoute(args, opts) {
  return buildCodexDeveloperInstructionRoute(args, opts);
}

function _toCodexConfigKey(name = "atlas_mcp") {
  const normalized = String(name || "atlas_mcp")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_");
  return normalized || "atlas_mcp";
}

function _toTomlLiteral(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return '""';
  return JSON.stringify(value);
}

function _toTomlKeyPart(key) {
  const value = String(key || "");
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

const CODEX_MCP_ENV_ALLOWED_EXACT = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "ComSpec",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMP",
  "TEMP",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NVM_HOME",
  "NVM_SYMLINK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function shouldForwardCodexMcpEnvKey(envKey, extraAllowedKeys = null) {
  const key = String(envKey || "");
  if (!key) return false;
  if (CODEX_MCP_ENV_ALLOWED_EXACT.has(key)) return true;
  if (extraAllowedKeys instanceof Set && extraAllowedKeys.has(key)) return true;
  // Keep ATLAS server handles, but do not forward POSSE_* product configuration toggles.
  if (key.startsWith("ATLAS_")) return true;
  // Keep common Node/package-manager runtime knobs used by CLI subprocesses.
  if (key.startsWith("NODE_") || key.startsWith("NPM_")) return true;
  return false;
}

function appendCodexMcpEnvOverrides(configOverrides, serverKey, env = {}, { extraAllowedKeys = [] } = {}) {
  const extraAllowed = new Set((Array.isArray(extraAllowedKeys) ? extraAllowedKeys : []).filter(Boolean));
  if (!env || typeof env !== "object") return;
  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey || envValue == null || envValue === "") continue;
    if (!shouldForwardCodexMcpEnvKey(envKey, extraAllowed)) continue;
    configOverrides.push(`mcp_servers.${serverKey}.env.${_toTomlKeyPart(envKey)}=${_toTomlLiteral(envValue)}`);
  }
}

async function buildCodexAtlasConfigOverridesAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "codex", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: "codex",
      cwd,
      assignmentUnit,
      workItemId,
      config: resolvedAtlasConfig,
    });
  if (!attachment.active || attachment.transport !== "mcp") {
    return {
      attachment,
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = buildAtlasMcpServerConfig(role, { cwd, config: resolvedAtlasConfig });
  if (!serverConfig?.ready) {
    return {
      attachment: { ...attachment, active: false, tools: [] },
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const serverKey = _toCodexConfigKey(serverConfig.name || "atlas_mcp");
  const configOverrides = [];
  if (serverConfig.transport === "http") {
    configOverrides.push(`mcp_servers.${serverKey}.url=${_toTomlLiteral(serverConfig.url)}`);
  } else {
    configOverrides.push(`mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`);
    configOverrides.push(`mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`);
    if (serverConfig.cwd) {
      configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
    }
    appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env);
  }

  return {
    attachment,
    configOverrides,
    serverConfig,
    serverKey,
  };
}

export function __testBuildCodexAtlasConfigOverrides(role, cwd, options = {}) {
  return buildCodexAtlasConfigOverridesAsync(role, cwd, options);
}

function buildCodexDeterministicReadConfigOverrides(role, cwd, {
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = buildDeterministicReadMcpServerConfig(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "codex",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  });
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const configOverrides = [
    `mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`,
    `mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`,
  ];
  const toolNames = getDeterministicMcpToolNames(role, { needsImageGeneration });
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });

  return {
    active: true,
    tools: toolNames,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "codex",
      serverName: serverKey,
    }),
    configOverrides,
    serverConfig,
    serverKey,
  };
}

export function __testBuildCodexDeterministicReadConfigOverrides(role, cwd, options = {}) {
  return buildCodexDeterministicReadConfigOverrides(role, cwd, options);
}

async function buildCodexDeterministicReadConfigOverridesAsync(role, cwd, {
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = await buildDeterministicReadMcpServerConfigAsync(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "codex",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  });
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const configOverrides = [
    `mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`,
    `mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`,
  ];
  const toolNames = getDeterministicMcpToolNames(role, { needsImageGeneration });
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });

  return {
    active: true,
    tools: toolNames,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "codex",
      serverName: serverKey,
    }),
    configOverrides,
    serverConfig,
    serverKey,
  };
}

function buildCodexSystemToolLockdownOverrides({ disableSystemTools = false } = {}) {
  if (!disableSystemTools) return [];
  return [
    "features.shell_tool=false",
    "features.unified_exec=false",
  ];
}

export function __testBuildCodexSystemToolLockdownOverrides(options = {}) {
  return buildCodexSystemToolLockdownOverrides(options);
}

function _extractCodexEventBody(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.msg && typeof msg.msg === "object" && typeof msg.msg.type === "string") return msg.msg;
  if (msg.payload && typeof msg.payload === "object" && typeof msg.payload.type === "string") return msg.payload;
  if (typeof msg.type === "string") return msg;
  if (msg.body && typeof msg.body === "object") return _extractCodexEventBody(msg.body);
  return null;
}

function normalizeCodexSessionHandle(value) {
  const text = String(value || "").trim();
  return text || null;
}

function pickCodexSessionHandle(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  for (const key of [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ]) {
    const handle = normalizeCodexSessionHandle(candidate[key]);
    if (handle) return handle;
  }
  return null;
}

function extractCodexSessionHandleFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const body = _extractCodexEventBody(msg);
  const candidates = [
    body,
    msg.session,
    msg.conversation,
    msg.thread,
    msg.result,
    msg.response,
    msg.payload,
    msg.msg,
  ];
  for (const candidate of candidates) {
    const handle = pickCodexSessionHandle(candidate);
    if (handle) return handle;
  }
  return null;
}

export function __testExtractCodexSessionHandleFromStreamMessage(msg) {
  return extractCodexSessionHandleFromStreamMessage(msg);
}

function _stringifyCodexCommand(command) {
  if (Array.isArray(command)) return command.filter((p) => p != null).map(String).join(" ");
  if (command == null) return "";
  return String(command);
}

function _parseCodexToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function probeCodexCliAsync(exePath) {
  const target = String(exePath || "").trim();
  if (!target) return { ok: false, path: target, reason: "empty path", missingFlags: [] };
  if (isProtectedWindowsAppCodexPath(target)) {
    return { ok: false, path: target, reason: "protected WindowsApps resource binary", missingFlags: [] };
  }
  if (!(await isExecutableCodexCliAsync(target))) {
    return { ok: false, path: target, reason: "codex --version failed", missingFlags: [] };
  }
  try {
    const launch = buildWindowsSpawn(target, ["exec", "resume", "--help"]);
    const result = await spawnProbeAsync(launch.command, launch.args, {
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    }, 3000);
    if (!result || result.status !== 0) {
      return { ok: false, path: target, reason: "codex exec resume --help failed", missingFlags: [] };
    }
    const help = `${result.stdout || ""}\n${result.stderr || ""}`;
    const missingFlags = CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => !help.includes(flag));
    if (missingFlags.length > 0) {
      return { ok: false, path: target, reason: `missing required flags: ${missingFlags.join(", ")}`, missingFlags };
    }
    return { ok: true, path: target, reason: null, missingFlags: [] };
  } catch (err) {
    return { ok: false, path: target, reason: err?.message || "probe failed", missingFlags: [] };
  }
}

async function chooseCodexCandidateAsync() {
  const checked = [];
  for (const candidate of getCodexCandidatePaths()) {
    const probe = await probeCodexCliAsync(candidate);
    checked.push(probe);
    if (probe.ok) return { selected: candidate, checked };
  }
  return { selected: null, checked };
}
async function isExecutableCodexCliAsync(exePath) {
  const target = String(exePath || "");
  if (!target) return false;
  try {
    const launch = buildWindowsSpawn(target, ["--version"]);
    const result = await spawnProbeAsync(launch.command, launch.args, {
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    }, 3000);
    return result && result.status === 0;
  } catch {
    return false;
  }
}

function _compactObject(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value != null && value !== ""));
}

function _extractCodexWebToolUse(body = {}, type = "") {
  const action = body.action && typeof body.action === "object" ? body.action : {};
  const query = body.query || body.search_query || action.query || action.search_query || null;
  const url = body.url || body.uri || action.url || action.uri || null;
  const callId = body.call_id || body.callId || body.id || null;
  if (/web_fetch|webfetch|open_page|open_url/i.test(type) || url) {
    return {
      tool: "web_fetch",
      input: _compactObject({ url, query }),
      call_id: callId,
    };
  }
  return {
    tool: "web_search",
    input: _compactObject({ query, url }),
    call_id: callId,
  };
}

function _parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function _extractCodexOutputText(value) {
  const parsed = _parseMaybeJson(value);
  if (parsed !== value) return _extractCodexOutputText(parsed);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => _extractCodexOutputText(item)).filter(Boolean).join("\n");
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["text", "output", "message", "error"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim();
    }
    if (Array.isArray(parsed.content)) return _extractCodexOutputText(parsed.content);
  }
  return typeof value === "string" ? value.trim() : "";
}

function _extractCodexToolUse(msg) {
  const body = _extractCodexEventBody(msg);
  if (!body) return null;
  const type = String(body.type || "").toLowerCase();
  if (type === "exec_command_begin" || type === "exec_command_start") {
    const command = _stringifyCodexCommand(body.command ?? body.cmd ?? body.argv);
    if (!command) return null;
    return { tool: "shell", input: { command, cwd: body.cwd || null } };
  }
  if (type === "patch_apply_begin" || type === "apply_patch_begin" || type === "apply_patch") {
    const changes = body.changes && typeof body.changes === "object" ? body.changes : null;
    if (!changes) return null;
    const results = [];
    for (const [pathKey, op] of Object.entries(changes)) {
      let changeKind = "update";
      if (op && typeof op === "object") {
        if ("add" in op) changeKind = "add";
        else if ("delete" in op) changeKind = "delete";
        else if ("update" in op) changeKind = "update";
      }
      results.push({ tool: "apply_patch", input: { file_path: pathKey, change_kind: changeKind } });
    }
    return results.length > 0 ? results : null;
  }
  if (/^web_.*(?:call|begin|start)?$/.test(type) || type === "web_search" || type === "web_fetch") {
    return _extractCodexWebToolUse(body, type);
  }
  if (type === "function_call" || type === "tool_call") {
    const toolName = body.name || body.tool;
    if (!toolName) return null;
    return {
      tool: String(toolName),
      input: _parseCodexToolArguments(body.arguments ?? body.args),
      call_id: body.call_id || body.callId || null,
    };
  }
  if (type === "function_call_output" || type === "tool_call_output") {
    const outputText = _extractCodexOutputText(body.output ?? body.result ?? body.content);
    if (/user cancelled MCP tool call/i.test(outputText)) {
      return {
        _codexToolOutput: true,
        call_id: body.call_id || body.callId || null,
        status: "cancelled",
        error: "user cancelled MCP tool call",
        output: outputText,
      };
    }
    return null;
  }
  if (type === "mcp_tool_call_begin" || type === "mcp_tool_begin") {
    const invocation = body.invocation || body.tool_call || body;
    const toolName = invocation?.tool || invocation?.name;
    if (!toolName) return null;
    const args = invocation?.arguments ?? invocation?.args ?? {};
    return {
      tool: String(toolName),
      input: (args && typeof args === "object") ? args : _parseCodexToolArguments(args),
      call_id: invocation?.call_id || invocation?.callId || body.call_id || body.callId || null,
    };
  }
  return null;
}

export function __testExtractCodexToolUse(msg) {
  return _extractCodexToolUse(msg);
}

function _appendCodexToolUse(toolUses, extracted) {
  if (!extracted) return;
  const entries = Array.isArray(extracted) ? extracted : [extracted];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry._codexToolOutput) {
      const callId = entry.call_id || entry.callId || null;
      const existing = callId
        ? [...toolUses].reverse().find((toolUse) => (toolUse.call_id || toolUse.callId || null) === callId)
        : null;
      if (existing) {
        existing.status = entry.status || existing.status || null;
        existing.error = entry.error || existing.error || null;
        existing.output = entry.output || existing.output || null;
      }
      continue;
    }
    toolUses.push(entry);
  }
}

export function __testAppendCodexToolUseEvent(toolUses, msg) {
  _appendCodexToolUse(toolUses, _extractCodexToolUse(msg));
  return toolUses;
}

function summarizeJsonEvent(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.msg === "string") return msg.msg;
  if (typeof msg.message === "string") return msg.message;
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.output === "string") return msg.output;
  if (typeof msg.status === "string") return `[status] ${msg.status}`;
  if (typeof msg.event === "string") return `[event] ${msg.event}`;
  if (typeof msg.type === "string") return `[${msg.type}]`;
  return null;
}

function normalizeTokenCount(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickUsageValue(candidate, names) {
  for (const name of names) {
    const value = normalizeTokenCount(candidate?.[name]);
    if (value != null) return value;
  }
  return null;
}

function pickUsageMetric(candidate, cumulativeNames, deltaNames, ambiguousNames) {
  const cumulative = pickUsageValue(candidate, cumulativeNames);
  if (cumulative != null) return { value: cumulative, kind: "cumulative" };
  const delta = pickUsageValue(candidate, deltaNames);
  if (delta != null) return { value: delta, kind: "delta" };
  const ambiguous = pickUsageValue(candidate, ambiguousNames);
  if (ambiguous != null) return { value: ambiguous, kind: "ambiguous" };
  return { value: null, kind: null };
}

// Token usage from the codex CLI's streaming protocol. The protocol does not
// have a stable canonical schema across versions: each event may carry a
// "total" cumulative count, a delta, or an ambiguous "input_tokens" field that
// could be either. We classify each field by name (cumulative > delta >
// ambiguous) and the accumulator picks the latest cumulative if seen, the sum
// of deltas otherwise, or a heuristic over ambiguous values (treated as
// deltas if values decrease, else cumulative).
//
// Cost numbers for codex calls inherit the heuristic's accuracy; if codex
// updates its event schema, audit pickUsageMetric below first.
function extractUsageFromEvent(msg) {
  if (!msg || typeof msg !== "object") {
    return { inputTokens: null, outputTokens: null, inputKind: null, outputKind: null };
  }
  const candidates = [msg.usage, msg.token_usage, msg.tokens, msg.metrics];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const input = pickUsageMetric(
      c,
      ["total_input_tokens", "input_tokens_total", "totalInputTokens", "inputTokensTotal", "total_prompt_tokens", "prompt_tokens_total", "promptTokensTotal"],
      ["input_tokens_delta", "delta_input_tokens", "inputTokensDelta", "input_delta_tokens", "prompt_tokens_delta", "delta_prompt_tokens", "promptTokensDelta"],
      ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]
    );
    const output = pickUsageMetric(
      c,
      ["total_output_tokens", "output_tokens_total", "totalOutputTokens", "outputTokensTotal", "total_completion_tokens", "completion_tokens_total", "completionTokensTotal"],
      ["output_tokens_delta", "delta_output_tokens", "outputTokensDelta", "output_delta_tokens", "completion_tokens_delta", "delta_completion_tokens", "completionTokensDelta"],
      ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]
    );
    const inputTokens = input.value;
    const outputTokens = output.value;
    if (inputTokens != null || outputTokens != null) {
      return {
        inputTokens,
        outputTokens,
        inputKind: input.kind,
        outputKind: output.kind,
      };
    }
  }
  return { inputTokens: null, outputTokens: null, inputKind: null, outputKind: null };
}

function codexUsageEventDedupeKey(msg) {
  if (!msg || typeof msg !== "object") return null;
  const candidates = [
    msg.event_id,
    msg.eventId,
    msg.id,
    msg.sequence_number,
    msg.sequenceNumber,
    msg.seq,
    msg.usage?.event_id,
    msg.usage?.eventId,
    msg.usage?.id,
    msg.token_usage?.event_id,
    msg.token_usage?.eventId,
    msg.token_usage?.id,
    msg.tokens?.event_id,
    msg.tokens?.eventId,
    msg.tokens?.id,
    msg.metrics?.event_id,
    msg.metrics?.eventId,
    msg.metrics?.id,
  ];
  const rawId = candidates.find((value) => value != null && String(value).trim() !== "");
  if (rawId == null) return null;
  const kind = String(msg.type || msg.event || msg.kind || "usage").trim() || "usage";
  return `${kind}:${String(rawId).trim()}`;
}

function createTokenUsageFieldAccumulator() {
  let explicitValue = null;
  let explicitSeen = false;
  let explicitPreviousCumulative = null;
  let explicitMaxSegment = null;
  const ambiguousValues = [];
  let ambiguousAsDeltas = false;

  const ambiguousTotal = () => {
    if (ambiguousValues.length === 0) return null;
    if (!ambiguousAsDeltas) return ambiguousValues[ambiguousValues.length - 1];
    return ambiguousValues.reduce((sum, value) => sum + value, 0);
  };
  const addExplicitSegment = (segment) => {
    const n = normalizeTokenCount(segment);
    if (n == null) return;
    explicitMaxSegment = Math.max(explicitMaxSegment ?? 0, n);
  };
  const ambiguousMaxSegment = () => {
    if (ambiguousValues.length === 0) return null;
    if (ambiguousAsDeltas) return Math.max(...ambiguousValues);
    let maxSegment = 0;
    let prev = null;
    for (const value of ambiguousValues) {
      const segment = prev == null || value < prev ? value : value - prev;
      maxSegment = Math.max(maxSegment, segment);
      prev = value;
    }
    return maxSegment;
  };

  return {
    add(value, kind = "ambiguous") {
      const n = normalizeTokenCount(value);
      if (n == null) return;
      if (kind === "delta") {
        explicitValue = (explicitValue ?? 0) + n;
        explicitSeen = true;
        addExplicitSegment(n);
        return;
      }
      if (kind === "cumulative") {
        explicitValue = n;
        explicitSeen = true;
        const segment = explicitPreviousCumulative == null || n < explicitPreviousCumulative
          ? n
          : n - explicitPreviousCumulative;
        explicitPreviousCumulative = n;
        addExplicitSegment(segment);
        return;
      }

      const prev = ambiguousValues.length > 0 ? ambiguousValues[ambiguousValues.length - 1] : null;
      ambiguousValues.push(n);
      if (prev != null && n < prev) ambiguousAsDeltas = true;
    },
    value() {
      return explicitSeen ? explicitValue : ambiguousTotal();
    },
    maxSegment() {
      return explicitSeen ? explicitMaxSegment : ambiguousMaxSegment();
    },
  };
}

function createCodexUsageAccumulator() {
  const input = createTokenUsageFieldAccumulator();
  const output = createTokenUsageFieldAccumulator();
  const seenUsageEvents = new Set();
  const snapshot = () => ({
    inputTokens: input.value(),
    outputTokens: output.value(),
    longContextInputTokens: input.maxSegment(),
  });
  return {
    add(usage, options = {}) {
      if (!usage || typeof usage !== "object") return snapshot();
      if (usage.inputTokens == null && usage.outputTokens == null) return snapshot();
      const eventKey = typeof options === "string" ? options : options?.eventKey;
      const normalizedKey = eventKey == null ? "" : String(eventKey).trim();
      if (normalizedKey) {
        if (seenUsageEvents.has(normalizedKey)) return snapshot();
        seenUsageEvents.add(normalizedKey);
      }
      input.add(usage.inputTokens, usage.inputKind || "ambiguous");
      output.add(usage.outputTokens, usage.outputKind || "ambiguous");
      return snapshot();
    },
    snapshot,
    get inputTokens() {
      return input.value();
    },
    get outputTokens() {
      return output.value();
    },
    get longContextInputTokens() {
      return input.maxSegment();
    },
  };
}

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

export const extractJson = _extractJsonClaude;

export function tripRateLimit(backoffSec, reason = "") {
  providerRuntimeState.tripRateLimit("codex", backoffSec, reason);
}

export function getRateLimitState() {
  return providerRuntimeState.getRateLimitState("codex");
}

export function parseErrorBackoff(err) {
  return classifyProviderError(err, { defaultBackoffSec: 15 });
}

function isCodexResumeHandleExpiredError(text) {
  return /(?:session|conversation|thread|resume).*(?:not\s+found|unknown|invalid|expired|no\s+such)|(?:not\s+found|unknown|invalid|expired|no\s+such).*(?:session|conversation|thread|resume)/i
    .test(String(text || ""));
}

export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
  modelTier = "standard",
  modelName = null,
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  autoApprove = false,
  scopedFiles = null,
  createFiles = null,
  createRoots = null,
  readRoots = null,
  deleteFiles = null,
  stableContext = null,
  remoteSystemPrompt = null,
  maxTurns = null,
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
  jobDir = null,
  onLine = null,
  cwd = null,          // real repo / worktree — codex sandbox root + MCP workspace
  loaderCwd = null,    // optional empty dir to spawn codex in (suppresses AGENTS.md parent-walk). Falls back to cwd.
  mcpCwd = null,       // optional override for MCP workspace root. Falls back to cwd.
  projectDir = null,
  abortSignal = null,
  stallTimeout = null,
  fallbackReads = null,
  needsImageGeneration = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  atlasPrefetchStatus = null,
  skipRolePrompt = false,
  recyclingMode = "fresh",
  priorSessionHandle = null,
  recordFinalPrompt = null,
  disableAtlas = false,
  atlasConfig = null,
} = {}) {
  const readiness = await isReadyAsync();
  if (!readiness.ready) {
    throw new Error(`Codex provider is not ready: ${readiness.reason}`);
  }
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasConfig = await buildCodexAtlasConfigOverridesAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );

  return new Promise((resolve, reject) => {
    void (async () => {
    try {
    const tierConfig = getModelTierConfig(modelTier);
    const authResolution = resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() });
    if (!authResolution.ok) {
      reject(new Error(authResolution.reason));
      return;
    }
    const preferredAuthMode = authResolution.mode;
    const requestedModel = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: tierConfig.model });
    const modelToUse = normalizeModelForAuthMode(requestedModel, preferredAuthMode);
    const turnLimit = maxTurns || getMaxTurns(role, modelTier, complexity, filesToModifyCount, deepthink);
    const providerPaths = normalizeProviderPaths({ cwd, projectDir });
    const workingDir = providerPaths.cwd;
    const mcpWorkspaceCwd = mcpCwd ? path.resolve(mcpCwd) : workingDir;
    const resumeSessionHandle = normalizeCodexSessionHandle(priorSessionHandle);
    const resumeContractNote = resumeSessionHandle || recyclingMode === "resume"
      ? "SESSION RESUME CONTRACT: follow the current execution contract, tool scope, sandbox policy, and working directory from this turn even if prior session history differs."
      : null;
    const spawnCwd = resumeSessionHandle ? workingDir : (loaderCwd ? path.resolve(loaderCwd) : workingDir);
    const assignmentUnit = assignmentUnitForAtlas;
    const { attachment: atlasAttachment, configOverrides: atlasConfigOverrides, serverKey: atlasMcpServerKey } = preparedAtlasConfig;
    const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
    logAtlasAttachment({
      attachment: atlasAttachment,
      jobId,
      workItemId,
      providerName: "codex",
      role,
    });
    if (atlasAttachment.failClosed) {
      const err = new Error(
        `ATLAS required mode blocks ${role} on codex (${atlasAttachment.requiredFailureReason || "unavailable"}).`
      );
      err.code = "ATLAS_REQUIRED_BLOCKED";
      err.atlas = atlasAttachment;
      reject(err);
      return;
    }
    const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
    const disableSystemTools = resolveDisableSystemTools();
    const atlasReadyForMcp = hasProviderVisibleAtlasMcpTools({
      disableAtlas,
      atlasPrefetchStatus,
      atlasAttachment,
    });
    const deterministicReadMcp = await buildCodexDeterministicReadConfigOverridesAsync(role, mcpWorkspaceCwd, {
      scopedFiles,
      createFiles,
      deleteFiles,
      createRoots,
      readRoots,
      needsImageGeneration,
      disableSystemTools,
      jobId,
      workItemId,
      attemptId,
      atlasPrefetchStatus,
      atlasAvailable: atlasReadyForMcp,
      atlasGateEnabled: atlasToolGateEnabled,
      atlasConfig,
    });
    let deterministicMcpSessionReleased = false;
    const cleanupDeterministicMcpSession = () => {
      if (!deterministicReadMcp.serverConfig?.ownerSession) {
        return { released: false, reason: "missing_session" };
      }
      if (deterministicMcpSessionReleased) {
        return { released: false, reason: "already_released" };
      }
      deterministicMcpSessionReleased = true;
      try {
        return releaseDeterministicMcpServerSession(deterministicReadMcp.serverConfig, {
          reason: "provider_cleanup",
          context: { provider: "codex", role, jobId, workItemId, attemptId },
        });
      } catch (err) {
        return {
          released: false,
          reason: "release_error",
          error: { message: String(err?.message || err) },
        };
      }
    };
    const atlasServerName = deterministicReadMcp.active
      ? deterministicReadMcp.serverKey
      : atlasMcpServerKey;
    const atlasContractTools = atlasReadyForMcp
      ? buildMcpAtlasSurfaceToolDescriptors(atlasAttachment.tools, {
        providerName: "codex",
        serverName: atlasServerName,
      })
      : [];
    const promptAtlasAttachment = atlasReadyForMcp
      ? { ...atlasAttachment, surfaceToolNames: buildSurfaceNameMap(atlasContractTools) }
      : { ...atlasAttachment, active: false, tools: [] };
    // Disable AGENTS.md auto-discovery (parent-walk + fallback filenames).
    // Agents access the real repo via the deterministic MCP, not via auto-loaded project docs.
    const memorySuppressionOverrides = ["project_doc_max_bytes=0"];
    const systemToolLockdownOverrides = buildCodexSystemToolLockdownOverrides({ disableSystemTools });
    const webTools = buildCodexWebToolsOverrides({
      role,
      roleMode,
      webToolsEnabled: resolveWebToolsEnabled(),
    });
    // The Posse MCP gateway exposes deterministic and atlas.* suites from a
    // single process, so do not attach a second ATLAS MCP server when the
    // gateway is already active.
    const atlasServedByGateway = !!deterministicReadMcp.active;
    const combinedConfigOverrides = [
      ...memorySuppressionOverrides,
      ...systemToolLockdownOverrides,
      ...deterministicReadMcp.configOverrides,
      ...(atlasServedByGateway || !atlasReadyForMcp ? [] : atlasConfigOverrides),
      ...webTools.configOverrides,
    ];
    const remoteSystemPromptText = String(remoteSystemPrompt || "").trim();
    const promptPrelude = remoteSystemPromptText;
    const shellDiscipline = __testBuildShellDisciplineBlock({ platform: process.platform, atlasAttachment: promptAtlasAttachment, atlasPrefetchStatus });
    const roleGuard = __testBuildCodexRoleGuardBlock({ role, allowWrite });
    let executionContract = buildExecutionContract({
      provider: "codex",
      role,
      roleMode,
      allowWrite,
      scopedFiles,
      createFiles,
      createRoots,
      deleteFiles,
      readRoots,
      needsImageGeneration,
      fallbackReads,
      platform: process.platform,
      includeBaseTools: !(deterministicReadMcp.active || disableSystemTools),
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    executionContract = adaptExecutionContractForProvider(executionContract, "codex");
    const contractBlock = renderExecutionContractBlock(executionContract);
    const atlasUnavailableReason = isFallbackAtlasPrefetchStatus(atlasPrefetchStatus)
      ? `preflight status ${String(atlasPrefetchStatus || "failed")}`
      : `transport ${atlasAttachment.transport}`;
    const atlasNote = (!atlasReadyForMcp && atlasAttachment.configured && atlasAttachment.phase)
      ? `${atlasBackendLabel(atlasAttachment)} CONTEXT ROUTE: requested for ${role} (${atlasAttachment.phase}) but unavailable on codex (${atlasUnavailableReason}); continue with deterministic file tools.`
      : null;
    const strictMcpNote = disableSystemTools
      ? "STRICT MCP MODE: Native/system tools are disabled for this run. Use deterministic MCP tools only."
      : null;
    const webToolsNote = webTools.active ? buildCodexWebToolsNote(role) : null;
    const developerInstructionRoute = buildCodexDeveloperInstructionRoute({
      promptPrelude,
      contractBlock,
      stableContext,
      atlasNote,
      strictMcpNote,
      webToolsNote,
      shellDiscipline,
      roleGuard,
    });
    if (developerInstructionRoute.configOverride) {
      combinedConfigOverrides.push(developerInstructionRoute.configOverride);
    }
    const finalPrompt = [
      developerInstructionRoute.inlinePromptPrelude ? `ROLE INSTRUCTIONS:\n${developerInstructionRoute.inlinePromptPrelude}` : null,
      Number.isFinite(Number(fallbackReads)) ? `FALLBACK READ BUDGET: ${Math.max(0, Number(fallbackReads))}` : null,
      turnLimit ? `MAX TURNS: ${turnLimit}` : null,
      resumeContractNote,
      `WORKING DIRECTORY: ${workingDir}`,
      jobDir ? `JOB DIR: ${jobDir}` : null,
      "",
      promptText,
    ].filter(Boolean).join("\n\n");

    if (typeof recordFinalPrompt === "function") {
      recordFinalPrompt(finalPrompt, { systemPrompt: developerInstructionRoute.developerInstructions });
    }

    const configRoute = prepareCodexConfigForSpawn(combinedConfigOverrides, {
      authMode: preferredAuthMode,
    });
    const temp = makeTempOutputFile();
    const cleanupRunTemps = (mcpAttachProofContext = null) => {
      const releaseResult = cleanupDeterministicMcpSession();
      let attachProofResult = null;
      if (mcpAttachProofContext) {
        try {
          attachProofResult = logProviderMcpAttachProofTelemetry({
            providerName: "codex",
            role,
            workItemId,
            jobId,
            attemptId,
            deterministicReadMcp: mcpAttachProofContext.deterministicReadMcp || deterministicReadMcp,
            releaseResult,
            exitCode: mcpAttachProofContext.exitCode ?? null,
            phase: mcpAttachProofContext.phase || "provider_cleanup",
          });
        } catch {
          attachProofResult = null;
        }
      }
      cleanupTempDir(temp.dir);
      configRoute.cleanup();
      return { releaseResult, attachProofResult };
    };
    const clearExitCleanup = registerCodexExitCleanup(cleanupRunTemps);
    const forceReadOnlySandbox = !!(deterministicReadMcp.active && allowWrite);
    logProviderMcpSurfaceTelemetry({
      providerName: "codex",
      role,
      workItemId,
      jobId,
      attemptId,
      deterministicReadMcp,
      atlasReadyForMcp,
      atlasContractTools,
      mcpServerNames: [
        deterministicReadMcp.active ? deterministicReadMcp.serverKey : null,
        (!atlasServedByGateway && atlasReadyForMcp) ? atlasMcpServerKey : null,
      ].filter(Boolean),
      configOverrideCount: combinedConfigOverrides.length,
      forceReadOnlySandbox,
    });
    const args = buildCodexExecArgs({
      outputFile: temp.file,
      workingDir,
      allowWrite,
      modelToUse,
      configOverrides: configRoute.configOverrides,
      forceReadOnlySandbox,
      priorSessionHandle: resumeSessionHandle,
    });

    const extraDirs = collectCodexExtraDirs({ workingDir, scopedFiles, createFiles, createRoots, readRoots });
    if (resumeSessionHandle && extraDirs.size > 0) {
      clearExitCleanup();
      cleanupRunTemps();
      const err = new Error("Codex session resume cannot enforce --add-dir scope; falling back to fresh execution is required.");
      err.code = "CODEX_RESUME_CONTRACT_UNSUPPORTED";
      reject(err);
      return;
    }
    for (const dir of extraDirs) {
      args.splice(args.length - 1, 0, "--add-dir", dir);
    }

    const color = roleBrandColor(role, C.cyan);
    const icon = roleBrandIcon(role);
    const directOutput = !onLine && !silent;
    const showHeader = directOutput && role !== "assessor";

    if (showHeader) {
      const tierLabel = ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}`;
      const modelLabel = modelToUse ? ` ${C.dim}model:${modelToUse}${C.reset}` : "";
      const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";
      console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
      console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${modelLabel} ${C.dim}(codex)${C.reset}${actLabel}`);
      console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
    }

    const emit = (line) => {
      if (!line) return;
      if (directOutput) process.stdout.write(`${color}|${C.reset} ${line}\n`);
      else if (onLine) onLine(line);
    };

    const childEnv = buildRuntimeEnv(providerPaths.projectDir, providerPaths.cwd, process.env);
    if (preferredAuthMode === "oauth") {
      delete childEnv.CODEX_API_KEY;
      delete childEnv.OPENAI_API_KEY;
    }
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete childEnv.XAI_API_KEY;
    delete childEnv.GITHUB_TOKEN;
    if (configRoute.codexHome) childEnv.CODEX_HOME = configRoute.codexHome;

    const launch = buildWindowsSpawn(CODEX_CMD, args);
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let totalInputTokens = null;
    let totalOutputTokens = null;
    let longContextInputTokens = null;
    let latestSessionHandle = resumeSessionHandle || null;
    const buildSpawnError = (err) => {
      const durationMs = Date.now() - startTime;
      const wrapped = new Error(
        `Failed to spawn codex at: ${formatSpawnLaunchForError(launch)}\n${err.message}`
      );
      wrapped.code = err.code || null;
      wrapped.stats = {
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        provider: "codex",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        longContextInputTokens,
        durationMs,
      };
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      return wrapped;
    };
    let proc;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: spawnCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (err) {
      clearExitCleanup();
      cleanupRunTemps();
      reject(buildSpawnError(err));
      return;
    }

    const forceKillTimers = new Set();
    const scheduleForceKill = () => {
      const timer = setTimeout(() => {
        forceKillTimers.delete(timer);
        terminateSpawnedProcess(proc, { force: true });
      }, 3000);
      forceKillTimers.add(timer);
      if (typeof timer.unref === "function") timer.unref();
    };
    const clearForceKillTimers = () => {
      for (const timer of forceKillTimers) clearTimeout(timer);
      forceKillTimers.clear();
    };

    if (abortSignal) {
      const onAbort = () => {
        terminateSpawnedProcess(proc, { force: process.platform === "win32" });
        if (process.platform !== "win32") {
          scheduleForceKill();
        }
      };
      if (abortSignal.aborted) onAbort();
      else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => abortSignal.removeEventListener("abort", onAbort));
      }
    }

    proc.stdin.on("error", () => {});
    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    const usageAccumulator = createCodexUsageAccumulator();
    let killedByStallDetector = false;
    let stallKillReason = "no_output";
    let lastActivity = Date.now();
    let lastMeaningfulActivity = lastActivity;
    const seenStderrNotices = new Set();
    const toolUses = [];
    let stdoutLineBuffer = "";
    const LINE_BUF_MAX = 16 * 1024 * 1024;
    const handleStdoutLine = (raw) => {
      if (!raw) return;
      try {
        const msg = JSON.parse(raw);
        latestSessionHandle = extractCodexSessionHandleFromStreamMessage(msg) || latestSessionHandle;
        const usage = extractUsageFromEvent(msg);
        const totals = usageAccumulator.add(usage, { eventKey: codexUsageEventDedupeKey(msg) });
        if (totals.inputTokens != null) totalInputTokens = totals.inputTokens;
        if (totals.outputTokens != null) totalOutputTokens = totals.outputTokens;
        if (totals.longContextInputTokens != null) longContextInputTokens = totals.longContextInputTokens;
        const extracted = _extractCodexToolUse(msg);
        const extractedEntries = Array.isArray(extracted) ? extracted : (extracted ? [extracted] : []);
        const webToolUses = extractedEntries.filter((entry) => entry && isWebToolName(entry.tool));
        if (webToolUses.length > 0) {
          recordToolUseObservations({
            tool_uses: webToolUses,
            cwd: workingDir,
          });
        }
        _appendCodexToolUse(toolUses, extracted);
        const summary = summarizeJsonEvent(msg);
        if (extractedEntries.length > 0 || summary) lastMeaningfulActivity = Date.now();
        if (summary) emit(`${C.dim}${summary}${C.reset}`);
      } catch {
        lastMeaningfulActivity = Date.now();
        emit(`${C.dim}${raw}${C.reset}`);
      }
    };

    const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
    const baseTimeout = resolveProviderStallTimeout(stallTimeout);
    const stallMs = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;
    const semanticStallMs = role === "assessor" ? Math.min(stallMs, 300_000) : stallMs;

    const heartbeat = setInterval(() => {
      const now = Date.now();
      const noByteOutput = now - lastActivity > stallMs;
      const noMeaningfulProgress = role === "assessor" && now - lastMeaningfulActivity > semanticStallMs;
      if (noByteOutput || noMeaningfulProgress) {
        clearInterval(heartbeat);
        killedByStallDetector = true;
        stallKillReason = noMeaningfulProgress
          ? `no assessor progress for ${(semanticStallMs / 1000)}s`
          : `no output for ${(stallMs / 1000)}s`;
        emit(`${C.red}!! Stalled (${stallKillReason}) -- killing process${C.reset}`);
        terminateSpawnedProcess(proc, { force: process.platform === "win32" });
        if (process.platform !== "win32") {
          scheduleForceKill();
        }
      }
    }, 500);

    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");

    proc.stdout.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stdout = appendBoundedCodexOutput(stdout, text);
        lastActivity = Date.now();
        const parts = `${stdoutLineBuffer}${text}`.split(/\r?\n/);
        stdoutLineBuffer = parts.pop() || "";
        if (stdoutLineBuffer.length > LINE_BUF_MAX) {
          emit(`${C.yellow}Codex stdout line exceeded ${LINE_BUF_MAX} bytes without newline -- dropping buffer${C.reset}`);
          stdoutLineBuffer = "";
        }
        for (const raw of parts.filter(Boolean)) handleStdoutLine(raw);
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        emit(`${C.yellow}[provider] Codex stdout handler error: ${msg}${C.reset}`);
      }
    });

    proc.stderr.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stderr = appendBoundedCodexOutput(stderr, text);
        lastActivity = Date.now();
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          const classified = __testClassifyCodexStderrLine(line);
          if (!classified.display) continue;
          if (classified.dedupeKey && seenStderrNotices.has(classified.dedupeKey)) continue;
          if (classified.dedupeKey) seenStderrNotices.add(classified.dedupeKey);
          lastMeaningfulActivity = Date.now();
          emit(classified.display);
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        emit(`${C.yellow}[provider] Codex stderr handler error: ${msg}${C.reset}`);
      }
    });

    proc.on("error", (err) => {
      clearInterval(heartbeat);
      clearForceKillTimers();
      clearExitCleanup();
      cleanupRunTemps({ deterministicReadMcp, exitCode: null, phase: "provider_error" });
      reject(buildSpawnError(err));
    });

    proc.on("close", (code) => {
      clearInterval(heartbeat);
      clearForceKillTimers();
      clearExitCleanup();
      const durationMs = Date.now() - startTime;
      if (stdoutLineBuffer.trim()) {
        handleStdoutLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = "";
      }
      let finalOutput = "";
      let mcpCleanup = null;
      try {
        finalOutput = fs.existsSync(temp.file) ? fs.readFileSync(temp.file, "utf-8").trim() : "";
      } catch {
        finalOutput = "";
      } finally {
        mcpCleanup = cleanupRunTemps({ deterministicReadMcp, exitCode: code, phase: "provider_close" });
      }

      const stats = __testBuildCloseStats({
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        totalInputTokens,
        totalOutputTokens,
        longContextInputTokens,
        durationMs,
        finalOutput,
        stdout,
        code,
        atlasMethod: atlasMethodForStats,
        toolUses,
        toolUsesLoggedByToolkit: !!deterministicReadMcp.active,
        sessionHandle: latestSessionHandle,
        priorSessionHandle: resumeSessionHandle,
      });
      stats.mcpAttachProof = mcpCleanup?.attachProofResult?.proof || null;
      stats.mcpAttachMissingProof = mcpCleanup?.attachProofResult?.missingProof === true;

      // Persist MCP-relevant CLI stderr (only when present) so a gateway
      // attach-under-load failure leaves a trace even on a clean exit.
      try {
        logProviderCliStderrTelemetry({
          providerName: "codex",
          role,
          workItemId,
          jobId,
          attemptId,
          exitCode: code,
          stderr,
        });
      } catch { /* telemetry only */ }

      if (code === 0) {
        if (stats.mcpAttachMissingProof) {
          const err = new Error("Codex deterministic MCP attach proof missing: provider exited without owner-observed initialize/tools-list.");
          err.code = "MCP_ATTACH_PROOF_MISSING";
          err.stats = stats;
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = finalOutput || stdout.trim() || null;
          err.partialOutput = err.output;
          err.toolUses = toolUses;
          err.mcpAttachMissingProof = true;
          reject(err);
          return;
        }
        resolve({ output: finalOutput || stdout.trim(), stats });
        return;
      }

      const err = new Error(
        killedByStallDetector
          ? `Codex CLI stalled after ${(durationMs / 1000).toFixed(1)}s and was killed (${stallKillReason})`
          : `Codex CLI exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      );
      err.code = code;
      err.stats = stats;
      err.stallKill = killedByStallDetector;
      err.stallReason = stallKillReason;
      err.sessionExpired = !!resumeSessionHandle && isCodexResumeHandleExpiredError(`${stderr}\n${stdout}\n${finalOutput}`);
      if (err.sessionExpired) err.stats.sessionExpired = true;
      err.stdout = stdout;
      err.stderr = stderr;
      err.output = finalOutput || stdout.trim() || null;
      err.partialOutput = err.output;
      err.toolUses = toolUses;
      err.mcpAttachMissingProof = stats.mcpAttachMissingProof;
      reject(err);
    });
    } catch (err) {
      reject(err);
    }
    })();
  });
}


export { C, ask, askMultiline };
export const __testBuildCodexSpawn = buildWindowsSpawn;
export const __testPrepareCodexConfigForSpawn = prepareCodexConfigForSpawn;
export const __testShouldSpillCodexConfigOverrides = shouldSpillCodexConfigOverrides;
export const __testTerminateSpawnedProcess = terminateSpawnedProcess;
export const __testExtractCodexUsageFromEvent = extractUsageFromEvent;
export const __testCodexUsageEventDedupeKey = codexUsageEventDedupeKey;
export const __testCreateCodexUsageAccumulator = createCodexUsageAccumulator;
export const __testParseCodexStatusText = parseCodexStatusText;
export const __testNormalizeCodexStatusSummary = normalizeCodexStatusSummary;
export const __testNormalizeCodexRateLimitsResponse = normalizeCodexRateLimitsResponse;
export const __testFetchCodexStatusViaInteractive = fetchCodexStatusViaInteractive;
export const __testFetchCodexRateLimitsViaAppServer = fetchCodexRateLimitsViaAppServer;
export const __testBuildCodexLocalUsageSummary = buildCodexLocalUsageSummary;

export function __testRegisterCodexExitCleanup(cleanup) {
  assertTestContext("__testRegisterCodexExitCleanup");
  return registerCodexExitCleanup(cleanup);
}

export function __testDrainCodexExitCleanups() {
  assertTestContext("__testDrainCodexExitCleanups");
  drainCodexExitCleanups();
}

export function __testSetCodexUsageFetchers({ interactive = null, appServer = null } = {}) {
  assertTestContext("__testSetCodexUsageFetchers");
  _testFetchCodexStatusViaInteractive = typeof interactive === "function" ? interactive : null;
  _testFetchCodexRateLimitsViaAppServer = typeof appServer === "function" ? appServer : null;
}

export function __testResetCodexUsageState() {
  assertTestContext("__testResetCodexUsageState");
  _usageSummaryCache = null;
  _interactiveUsageUnavailableReason = null;
  _testFetchCodexStatusViaInteractive = null;
  _testFetchCodexRateLimitsViaAppServer = null;
}

export function __testGetCodexInteractiveUsageUnavailableReason() {
  return _interactiveUsageUnavailableReason;
}
