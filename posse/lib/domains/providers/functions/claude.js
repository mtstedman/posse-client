// lib/provider/claude.js — Claude CLI caller + utilities
//
// Extracted from orchestrator.js v3. Handles:
// - Resolving the claude binary (including Windows .cmd parsing)
// - Spawning claude with streaming output
// - JSON extraction from LLM responses
// - Model tier configuration

import { execFile, spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getAccountSetting, setAccountSettings } from "../../settings/functions/account-settings.js";
import { getSetting } from "../../queue/functions/index.js";
import { appendExecutionTools, buildClaudeCliToolConfig, buildExecutionContract, renderExecutionContractBlock } from "../../../functions/tools/contract.js";
import { buildMcpAtlasSurfaceToolDescriptors, buildMcpSurfaceToolDescriptors, buildSurfaceNameMap, formatAtlasToolUseDisplayName } from "../../../functions/tools/mcp-surface.js";
import { buildRuntimeEnv, normalizeProviderPaths } from "../../runtime/functions/paths.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, logAtlasAttachment, resolveAtlasAssignmentUnit, resolveAtlasExecutionAttachment } from "../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfig, buildDeterministicReadMcpServerConfigAsync, getDeterministicMcpToolNames, roleUsesDeterministicReadMcp } from "../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../integrations/functions/deterministic-mcp/gate-settings.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME, stripPosseMcpGatewayPrefix } from "../../integrations/functions/mcp-gateway.js";
import { summarizeObservedToolUse } from "./helpers/tool-runtime.js";
import { buildWindowsSpawn, terminateSpawnedProcess } from "./helpers/windows-spawn.js";
import { discoverCommandCandidates } from "./helpers/cli-discovery.js";
import { hasProviderVisibleAtlasMcpTools } from "./helpers/atlas-mcp.js";
import { logProviderMcpSurfaceTelemetry, logProviderCliStderrTelemetry } from "./helpers/mcp-telemetry.js";
import { C } from "../../../shared/format/functions/colors.js";
import { stripAnsi } from "../../../shared/format/functions/ansi.js";
import { extractJson } from "../../../shared/format/functions/json.js";
import { providerRuntimeState } from "../classes/runtime-state-singleton.js";
import { getProviderTierDefaults } from "./model-catalog.js";
import { resolvePricing } from "../../billing/functions/pricing.js";
import { selectExecutionModel } from "./helpers/model-selection.js";
import { normalizeProviderUsage } from "./helpers/usage-normalization.js";
import {
  InteractiveCliSession,
  InteractiveCliUnavailableError,
  getDefaultInteractiveCliBackend,
  stripTerminalControls,
} from "./helpers/interactive-cli-session.js";
import { escalateModelTier, getMaxTurnsForProvider } from "./helpers/turns.js";
import { resolveProviderStallTimeout } from "./helpers/stall-timeout.js";
import { roleBrandColor, roleBrandIcon } from "../../ui/functions/display/helpers/brand.js";
import { classifyProviderError } from "./helpers/api-resilience.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";

export { C, extractJson };

export function scrubClaudeChildEnv(childEnv = {}) {
  delete childEnv.CODEX_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.XAI_API_KEY;
  delete childEnv.GITHUB_TOKEN;
  return childEnv;
}

const CLAUDE_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week", durationMs: 7 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_CLAUDE_USAGE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_CLAUDE_USAGE_BACKOFF_MS = 5 * 60 * 1000;
const CLAUDE_EXECUTION_MODE_PRINT = "print";
const CLAUDE_EXECUTION_MODE_INTERACTIVE = "interactive";
const CLAUDE_USAGE_SETTING_KEYS = {
  sessionUsed: "claude_session_tokens",
  sessionMax: "claude_session_max",
  sessionResetAt: "claude_session_reset_at",
  weekUsed: "claude_weekly_tokens",
  weekMax: "claude_weekly_max",
  weekResetAt: "claude_weekly_reset_at",
  subscriptionType: "claude_usage_subscription_type",
  rateLimitTier: "claude_usage_rate_limit_tier",
  source: "claude_usage_source",
  lastUpdated: "claude_usage_last_updated",
};
let _usageSummaryCache = null;
let _usageApiCache = null;
const _usageFileCache = new Map();
const CLAUDE_USAGE_DISK_CACHE_DIR = path.join("cache", "posse");
const CLAUDE_USAGE_DISK_CACHE_FILE = "claude-oauth-usage.json";
const ISOLATED_SYSTEM_PROMPT = [
  "You are an isolated Posse runtime worker.",
  "Use only the instructions, context, and tools explicitly provided by Posse for this job.",
  "Do not use user memory, user settings, local Claude project state, slash-command skills, prior sessions, or ambient workspace context.",
  "If needed context is not present in the prompt or available through the attached Posse tools, report that it is unavailable.",
].join("\n");
let _claudeConfigDirOverride = null;

function readPositiveMsSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isAccountSettingsBusyError(err) {
  const code = String(err?.code || "").toUpperCase();
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = String(err?.message || err || "");
  return /\bSQLITE_(?:BUSY|LOCKED)\b|database is (?:locked|busy)/i.test(message);
}

function claudeUsageCacheMs() {
  return readPositiveMsSetting(SETTING_KEYS.CLAUDE_USAGE_CACHE_MS, DEFAULT_CLAUDE_USAGE_CACHE_MS);
}

function claudeUsageBackoffMs() {
  return readPositiveMsSetting(SETTING_KEYS.CLAUDE_USAGE_BACKOFF_MS, DEFAULT_CLAUDE_USAGE_BACKOFF_MS);
}

async function buildClaudeAtlasMcpConfigPayloadAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "claude", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: "claude",
      cwd,
      assignmentUnit,
      workItemId,
      config: resolvedAtlasConfig,
    });
  if (!attachment.active || attachment.transport !== "mcp") {
    return { attachment, payload: null };
  }
  const server = buildAtlasMcpServerConfig(role, { cwd, config: resolvedAtlasConfig });
  if (!server?.ready) {
    return { attachment: { ...attachment, active: false, tools: [] }, payload: null };
  }
  const serverConfig = server.transport === "http"
    ? { type: "http", url: server.url }
    : {
      command: server.command,
      args: server.args || [],
      cwd: server.cwd || undefined,
      env: server.env || undefined,
    };
  const serverName = server.name || "atlas-v2";
  return {
    attachment,
    serverName,
    payload: {
      mcpServers: {
        [serverName]: serverConfig,
      },
    },
  };
}

export function __testBuildClaudeAtlasMcpConfigPayload(role, cwd, options = {}) {
  return buildClaudeAtlasMcpConfigPayloadAsync(role, cwd, options);
}

function buildClaudeDeterministicReadMcpConfigPayload(role, cwd, {
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
    return { active: false, tools: [], payload: null };
  }
  const server = buildDeterministicReadMcpServerConfig(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "claude",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  });
  if (!server?.ready) {
    return { active: false, tools: [], payload: null };
  }
  const serverName = server.name || POSSE_MCP_GATEWAY_SERVER_NAME;
  const toolNames = getDeterministicMcpToolNames(role, { needsImageGeneration });
  return {
    active: true,
    tools: toolNames,
    serverName,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "claude",
      serverName,
    }),
    payload: {
      mcpServers: {
        [serverName]: {
          command: server.command,
          args: server.args || [],
          cwd: server.cwd || undefined,
          env: server.env || undefined,
        },
      },
    },
  };
}

export function __testBuildClaudeDeterministicReadMcpConfigPayload(role, cwd, options = {}) {
  return buildClaudeDeterministicReadMcpConfigPayload(role, cwd, options);
}

async function buildClaudeDeterministicReadMcpConfigPayloadAsync(role, cwd, {
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
    return { active: false, tools: [], payload: null };
  }
  const server = await buildDeterministicReadMcpServerConfigAsync(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "claude",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  });
  if (!server?.ready) {
    return { active: false, tools: [], payload: null };
  }
  const serverName = server.name || POSSE_MCP_GATEWAY_SERVER_NAME;
  const toolNames = getDeterministicMcpToolNames(role, { needsImageGeneration });
  return {
    active: true,
    tools: toolNames,
    serverName,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "claude",
      serverName,
    }),
    payload: {
      mcpServers: {
        [serverName]: {
          command: server.command,
          args: server.args || [],
          cwd: server.cwd || undefined,
          env: server.env || undefined,
        },
      },
    },
  };
}

function isDeprecatedClaudeLogUsageEnabled() {
  return false;
}

// ─── Colors ──────────────────────────────────────────────────────────────────

// ─── Capabilities ───────────────────────────────────────────────────────────

export const capabilities = Object.freeze({
  images: false,
  sessionResume: true,
  toolAttachment: "mcp",
});

// ─── Model Tier Config ──────────────────────────────────────────────────────

// Maps the DB schema's model_tier + reasoning_effort to concrete Claude settings.
// Model overrides come from Posse settings, not shell env.
export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("claude").cheap.model,
    thinking: false,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("claude").standard.model,
    thinking: false,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("claude").strong.model,
    thinking: true,
    label: "STRONG",
    color: "magenta",
  },
};

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function getModelOverride() {
  return readModelSetting("claude_model") || null;
}

export function resolveWebToolsEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.WEB_TOOLS_ENABLED);
    if (stored == null) return true;
    const normalized = String(stored).trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return true;
  } catch {
    return true;
  }
}

// Resolution order: admin DB ("disable_system_tools") -> default true.
export function resolveDisableSystemTools() {
  try {
    const stored = getSetting(SETTING_KEYS.DISABLE_SYSTEM_TOOLS);
    if (stored != null && String(stored).trim() !== "") {
      const normalized = String(stored).trim().toLowerCase();
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
      return true;
    }
  } catch { /* DB unavailable; use default. */ }
  return true;
}

function normalizeClaudeExecutionMode(value, fallback = CLAUDE_EXECUTION_MODE_PRINT) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["interactive", "interactive-client", "pty", "terminal", "virtual-shell", "virtual_shell", "wrapper", "client"].includes(normalized)) {
    return CLAUDE_EXECUTION_MODE_INTERACTIVE;
  }
  if (["print", "stream", "stream-json", "stream_json", "-p", "default"].includes(normalized)) {
    return CLAUDE_EXECUTION_MODE_PRINT;
  }
  return fallback;
}

export function resolveClaudeExecutionMode({ requested = null, interactiveBackend = null } = {}) {
  if (requested != null && String(requested).trim() !== "") {
    return normalizeClaudeExecutionMode(requested);
  }
  if (interactiveBackend) return CLAUDE_EXECUTION_MODE_INTERACTIVE;
  const envValue = process.env.POSSE_CLAUDE_EXECUTION_MODE || process.env.CLAUDE_EXECUTION_MODE;
  if (envValue != null && String(envValue).trim() !== "") {
    return normalizeClaudeExecutionMode(envValue);
  }
  try {
    const stored = getSetting(SETTING_KEYS.CLAUDE_EXECUTION_MODE);
    if (stored != null && String(stored).trim() !== "") {
      return normalizeClaudeExecutionMode(stored);
    }
  } catch {
    // Settings DB may be unavailable in tests or early bootstrap.
  }
  return CLAUDE_EXECUTION_MODE_PRINT;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`claude_model_${key}`) || base.model,
  };
}

// ─── Max Turns Config ────────────────────────────────────────────────────────

// Per-role base turns. Role/tier/task modifiers are applied on top.
/**
 * Get max turns for a role, starting from a configurable base turn budget.
 *
 * For dev/artificer: complexity (1-5 from planner) drives the turn budget.
 * Low complexity tasks get fewer turns, high complexity tasks get more.
 * This prevents simple tasks from burning tokens on stuck loops while
 * giving complex tasks room to iterate.
 */
function getMaxTurns(role, modelTier = "standard", complexity = null, deepthink = false, filesToModifyCount = null) {
  return getMaxTurnsForProvider("claude", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function __testGetMaxTurns(role, modelTier = "standard", complexity = null, deepthink = false, filesToModifyCount = null) {
  return getMaxTurns(role, modelTier, complexity, deepthink, filesToModifyCount);
}

// ─── Resolve Claude Binary ──────────────────────────────────────────────────

let CLAUDE_CMD;
let CLAUDE_ARGS;
const CLAUDE_CLI_PATH_SETTING = "claude_cli_path";

export class ClaudeCliNotFoundError extends Error {
  constructor() {
    super("Could not find 'claude' on PATH. Install: npm install -g @anthropic-ai/claude-code");
    this.name = "ClaudeCliNotFoundError";
    this.code = "CLAUDE_CLI_NOT_FOUND";
  }
}

// `where claude` can return several entries from a single bin directory. npm's
// global install drops an extensionless POSIX shell shim (`claude`), a
// `claude.cmd`, and a `claude.ps1` side by side — and when Node itself lives in
// `C:\Program Files\nodejs` (npm's default global prefix) those land right next
// to node. `where` lists the extensionless shim first, but it is a `#!/bin/sh`
// script Windows CreateProcess cannot execute, so spawning it with shell:false
// fails (e.g. `spawn C:\Program Files\nodejs\claude ENOENT`). Walk the results in
// PATH order and take the first entry with an extension Windows can actually
// launch, falling back to the raw first line so a genuinely missing binary still
// surfaces the original error.
const WINDOWS_SPAWNABLE_CLAUDE_EXTS = new Set([".exe", ".cmd", ".bat", ".com"]);

function selectWindowsClaudeBinary(lines) {
  const candidates = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const spawnable = candidates.find((candidate) =>
    WINDOWS_SPAWNABLE_CLAUDE_EXTS.has(path.extname(candidate).toLowerCase())
  );
  return spawnable || candidates[0];
}

export function __testSelectWindowsClaudeBinary(lines) {
  return selectWindowsClaudeBinary(lines);
}

export function __testBuildClaudeSpawn(command, args = []) {
  return buildWindowsSpawn(command, args);
}

function readClaudeCliPathSetting() {
  try {
    const value = getSetting(CLAUDE_CLI_PATH_SETTING);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

// Parse an npm-style `claude.cmd` wrapper and return the absolute path to the JS
// entry point it launches (so we can run it as `node <entry>` rather than
// spawning the `.cmd` itself). Returns null when no entry can be parsed.
//
// npm emits the wrapper's own directory in one of two forms: the classic
// `%~dp0` (trailing-backslash) token, and the `%dp0%` token set by the
// `:find_dp0` helper that newer npm generates. Only rewriting `%~dp0` left the
// `%dp0%` form unresolved, so resolution fell back to spawning `claude.cmd`
// directly — which Node refuses with EINVAL since the CVE-2024-27980 fix
// (Node 18.20.2 / 20.12.2 / 21.7.2+). Rewrite both forms.
function extractCmdShimJsPath(cmdContent, binPath) {
  const content = String(cmdContent || "");
  const jsMatch = content.match(/"([^"]*(?:claude-code|claude)[^"]*\.(?:js|mjs))"/i)
               || content.match(/node\s+"?([^\s"]+\.(?:js|mjs))"?/i);
  if (!jsMatch) return null;
  const cmdDir = path.dirname(binPath);
  const jsPath = jsMatch[1]
    .replace(/%~dp0\\?/gi, cmdDir + path.sep)
    .replace(/%dp0%\\?/gi, cmdDir + path.sep);
  return path.resolve(jsPath);
}

export function __testExtractCmdShimJsPath(cmdContent, binPath) {
  return extractCmdShimJsPath(cmdContent, binPath);
}

function configureClaudeCommandFromBinary(binPath) {
  const isWin = process.platform === "win32";
  // On Windows, parse the .cmd wrapper to extract the JS entry point
  if (isWin && binPath.toLowerCase().endsWith(".cmd")) {
    try {
      const cmdContent = fs.readFileSync(binPath, "utf-8");
      const jsPath = extractCmdShimJsPath(cmdContent, binPath);
      if (jsPath && fs.existsSync(jsPath)) {
        CLAUDE_CMD = process.execPath;
        CLAUDE_ARGS = [jsPath];
        return;
      }
    } catch { /* fall through */ }

    CLAUDE_CMD = binPath;
    CLAUDE_ARGS = [];
    return;
  }

  CLAUDE_CMD = binPath;
  CLAUDE_ARGS = [];
}

function getClaudeCandidatePaths() {
  const configured = readClaudeCliPathSetting();
  return discoverCommandCandidates("claude", {
    extraPaths: configured ? [configured] : [],
  });
}

function findClaudeBinary() {
  const candidates = getClaudeCandidatePaths();
  if (candidates.length === 0) return null;
  return process.platform === "win32"
    ? selectWindowsClaudeBinary(candidates)
    : candidates[0];
}

export function discoverClaudeCli() {
  const candidates = getClaudeCandidatePaths();
  const selected = process.platform === "win32"
    ? selectWindowsClaudeBinary(candidates)
    : (candidates[0] || null);
  return {
    provider: "claude",
    settingKey: CLAUDE_CLI_PATH_SETTING,
    selected,
    candidates,
    ready: !!selected,
    reason: selected ? null : new ClaudeCliNotFoundError().message,
  };
}

function resolveClaude() {
  const binPath = findClaudeBinary();
  if (!binPath) throw new ClaudeCliNotFoundError();
  configureClaudeCommandFromBinary(binPath);
}
function ensureClaudeResolved() {
  if (!CLAUDE_CMD) resolveClaude();
}

function findClaudeBinaryAsync() {
  return new Promise((resolve, reject) => {
    try {
      const selected = findClaudeBinary();
      if (!selected) {
        reject(new ClaudeCliNotFoundError());
        return;
      }
      resolve(selected);
    } catch {
      reject(new ClaudeCliNotFoundError());
    }
  });
}
async function resolveClaudeAsync() {
  const binPath = await findClaudeBinaryAsync();
  if (process.platform === "win32" && binPath.toLowerCase().endsWith(".cmd")) {
    try {
      const cmdContent = await fs.promises.readFile(binPath, "utf-8");
      const jsPath = extractCmdShimJsPath(cmdContent, binPath);
      if (jsPath) {
        await fs.promises.access(jsPath);
        CLAUDE_CMD = process.execPath;
        CLAUDE_ARGS = [jsPath];
        return;
      }
    } catch {
      // Fall back to invoking the wrapper directly.
    }
    CLAUDE_CMD = binPath;
    CLAUDE_ARGS = [];
    return;
  }
  CLAUDE_CMD = binPath;
  CLAUDE_ARGS = [];
}

async function ensureClaudeResolvedAsync() {
  if (!CLAUDE_CMD) await resolveClaudeAsync();
}

export function __testResetClaudeResolution() {
  assertTestContext("__testResetClaudeResolution");
  CLAUDE_CMD = undefined;
  CLAUDE_ARGS = undefined;
}

export function __testSetClaudeResolution(command, args = []) {
  assertTestContext("__testSetClaudeResolution");
  CLAUDE_CMD = command || undefined;
  CLAUDE_ARGS = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}

export function getClaudeReadiness() {
  try {
    ensureClaudeResolved();
    return { ready: true, reason: null, cmd: CLAUDE_CMD, args: CLAUDE_ARGS };
  } catch (err) {
    if (err?.code === "CLAUDE_CLI_NOT_FOUND") {
      return { ready: false, reason: err.message };
    }
    throw err;
  }
}

export function isReady() {
  return getClaudeReadiness();
}

export function getClaudeInfo() {
  ensureClaudeResolved();
  return { cmd: CLAUDE_CMD, args: CLAUDE_ARGS };
}

function getClaudeConfigDir() {
  if (_claudeConfigDirOverride) return _claudeConfigDirOverride;
  return path.join(os.homedir(), ".claude");
}

export function setClaudeConfigDirForTests(configDir = null) {
  _claudeConfigDirOverride = configDir == null || String(configDir).trim() === ""
    ? null
    : path.resolve(String(configDir));
  _usageSummaryCache = null;
  _usageApiCache = null;
  _usageFileCache.clear();
}

function _failureText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return [
      value.message,
      value.stderr,
      value.stdout,
      value.partialOutput,
    ].filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    return [
      value.error,
      value.message,
      value.stderr,
      value.stdout,
      value.partialOutput,
    ].filter(Boolean).join("\n");
  }
  return String(value);
}

function classifyClaudeCliFailure(value) {
  const lines = _failureText(value)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const invalidClientLine = lines.find((line) => /\binvalid(?:[_\s-]+)client\b/i.test(line));
  if (invalidClientLine) {
    return {
      classification: "invalid_client",
      retryable: false,
      detail: invalidClientLine.slice(0, 240),
    };
  }
  const contentionLine = lines.find((line) =>
    /(?:another|existing|active).{0,40}\bclaude\b|\bclaude\b.{0,40}(?:already running|active|busy)|\b(?:lock(?:ed)?|busy|resource busy|ebusy|eperm|etxtbsy|database is locked|timed out|timeout)\b/i.test(line)
  );
  if (contentionLine) {
    return {
      classification: "local_contention",
      retryable: true,
      detail: contentionLine.slice(0, 240),
    };
  }
  return null;
}

export function __testClassifyClaudeCliFailure(value) {
  return classifyClaudeCliFailure(value);
}

function readClaudeCredentials(configDir = getClaudeConfigDir()) {
  const credentialsPath = path.join(configDir, ".credentials.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    const oauth = parsed?.claudeAiOauth || {};
    const organization = oauth.organization || parsed?.organization || {};
    return {
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
      oauthToken: String(
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        oauth.accessToken ||
        oauth.access_token ||
        parsed?.accessToken ||
        parsed?.access_token ||
        ""
      ).trim() || null,
      expiresAt:
        oauth.expiresAt ||
        oauth.expires_at ||
        parsed?.expiresAt ||
        parsed?.expires_at ||
        null,
      organizationUuid:
        oauth.organizationUuid ||
        oauth.organization_uuid ||
        organization.uuid ||
        organization.id ||
        null,
    };
  } catch {
    return {
      subscriptionType: null,
      rateLimitTier: null,
      oauthToken: String(process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim() || null,
      expiresAt: null,
      organizationUuid: null,
    };
  }
}

function normalizeClaudeOauthWarmupResult(result = {}) {
  const status = Number.isFinite(result.status) ? result.status : null;
  const signal = result.signal || null;
  const error = result.error ? String(result.error.message || result.error) : null;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const failure = classifyClaudeCliFailure({ error, stdout, stderr });
  return {
    attempted: true,
    ok: !error && status === 0,
    status,
    signal,
    error,
    stdout,
    stderr,
    classification: failure?.classification || null,
    retryable: failure?.retryable ?? null,
    detail: failure?.detail || null,
  };
}

function normalizeClaudeOauthWarmupError(err, { skipped = null } = {}) {
  const failure = classifyClaudeCliFailure(err);
  return {
    attempted: !skipped,
    ok: false,
    skipped,
    status: null,
    signal: null,
    error: String(err?.message || err || "warmup failed"),
    stdout: "",
    stderr: "",
    classification: failure?.classification || null,
    retryable: failure?.retryable ?? null,
    detail: failure?.detail || null,
  };
}

async function runClaudeWarmupViaInteractiveCli({
  cwd = null,
  timeoutMs = 20_000,
  backend = null,
} = {}) {
  const resolvedBackend = backend || getDefaultInteractiveCliBackend();
  if (!resolvedBackend) throw new InteractiveCliUnavailableError();
  await ensureClaudeResolvedAsync();
  const session = new InteractiveCliSession({
    command: CLAUDE_CMD,
    args: CLAUDE_ARGS,
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
    session.sendLine("Reply with OK.");
    await session.waitFor(
      (output) => /\bOK\b/i.test(stripTerminalControls(output)),
      { timeoutMs }
    );
    await session.waitForQuiet({ quietMs: 500, timeoutMs: Math.min(timeoutMs, 3_000) }).catch(() => {});
    session.sendLine("/exit");
    return {
      status: 0,
      signal: null,
      error: null,
      stdout: session.cleanTranscript(),
      stderr: "",
    };
  } finally {
    await session.close({ gracefulMs: 500 });
  }
}

export function warmOauthSession({ cwd = null, timeoutMs = 20_000 } = {}) {
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  try {
    ensureClaudeResolved();
  } catch (err) {
    if (err?.code === "CLAUDE_CLI_NOT_FOUND") {
      return {
        attempted: false,
        ok: false,
        skipped: "claude-cli-unavailable",
        error: err.message,
      };
    }
    throw err;
  }
  const prompt = "Reply with OK.";
  const invoke = typeof globalThis.__posseWarmClaudeOauthSession === "function"
    ? globalThis.__posseWarmClaudeOauthSession
    : ({ resolvedCwd, resolvedTimeoutMs }) => {
      const launch = buildWindowsSpawn(CLAUDE_CMD, [...CLAUDE_ARGS, "-p", "--max-turns", "1", "--output-format", "text"]);
      return spawnSync(
        launch.command,
        launch.args,
        {
          cwd: resolvedCwd,
          input: prompt,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          timeout: resolvedTimeoutMs,
        }
      );
    };

  try {
    const result = invoke({
      resolvedCwd: cwd || process.cwd(),
      resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
    }) || {};
    return normalizeClaudeOauthWarmupResult(result);
  } catch (err) {
    return normalizeClaudeOauthWarmupError(err);
  }
}

function spawnClaudeWarmupAsync({ resolvedCwd, resolvedTimeoutMs, prompt }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const launch = buildWindowsSpawn(CLAUDE_CMD, [...CLAUDE_ARGS, "-p", "--max-turns", "1", "--output-format", "text"]);
    const child = spawn(
      launch.command,
      launch.args,
      {
        cwd: resolvedCwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ status: null, signal: "SIGTERM", error: new Error("Claude OAuth warmup timed out") });
    }, resolvedTimeoutMs);
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("exit", (status, signal) => finish({ status, signal: signal || null, error: null }));
    child.stdin?.end(prompt);
  });
}

export async function warmOauthSessionInteractive({ cwd = null, timeoutMs = 20_000, interactiveBackend = null } = {}) {
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  try {
    const result = await runClaudeWarmupViaInteractiveCli({
      cwd,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
      backend: interactiveBackend,
    });
    return normalizeClaudeOauthWarmupResult(result);
  } catch (err) {
    const unavailable = err instanceof InteractiveCliUnavailableError || err?.code === "INTERACTIVE_CLI_UNAVAILABLE";
    return normalizeClaudeOauthWarmupError(err, {
      skipped: unavailable ? "interactive-cli-unavailable" : null,
    });
  }
}

export async function warmOauthSessionAsync({
  cwd = null,
  timeoutMs = 20_000,
  preferInteractive = false,
  interactiveBackend = null,
} = {}) {
  if (preferInteractive || interactiveBackend) {
    const interactive = await warmOauthSessionInteractive({ cwd, timeoutMs, interactiveBackend });
    if (interactive.attempted || interactiveBackend || interactive.skipped !== "interactive-cli-unavailable") {
      return interactive;
    }
  }
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  try {
    await ensureClaudeResolvedAsync();
  } catch (err) {
    if (err?.code === "CLAUDE_CLI_NOT_FOUND") {
      return {
        attempted: false,
        ok: false,
        skipped: "claude-cli-unavailable",
        error: err.message,
      };
    }
    throw err;
  }
  try {
    const prompt = "Reply with OK.";
    const result = typeof globalThis.__posseWarmClaudeOauthSessionAsync === "function"
      ? await globalThis.__posseWarmClaudeOauthSessionAsync({
        resolvedCwd: cwd || process.cwd(),
        resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
      })
      : await spawnClaudeWarmupAsync({
        resolvedCwd: cwd || process.cwd(),
        resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
        prompt,
      });
    return normalizeClaudeOauthWarmupResult(result || {});
  } catch (err) {
    return normalizeClaudeOauthWarmupError(err);
  }
}

export const __testRunClaudeWarmupViaInteractiveCli = runClaudeWarmupViaInteractiveCli;

function getClaudeUsageCachePath(configDir = getClaudeConfigDir()) {
  return path.join(configDir, CLAUDE_USAGE_DISK_CACHE_DIR, CLAUDE_USAGE_DISK_CACHE_FILE);
}

function readUsageSettingNumber(key) {
  const value = getAccountSetting(key);
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readUsageSettingString(key) {
  const value = getAccountSetting(key);
  if (value == null || String(value).trim() === "") return null;
  return String(value);
}

function isOauthUsageSettingsSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized.startsWith("anthropic-oauth-usage-api");
}

function buildClaudeUsageSummaryFromSettings(nowMs = Date.now(), { allowStale = false } = {}) {
  const lastUpdated = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.lastUpdated);
  if (!Number.isFinite(lastUpdated) || lastUpdated <= 0) return null;
  if (!allowStale && nowMs - lastUpdated > claudeUsageCacheMs()) return null;

  const sessionUsed = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.sessionUsed);
  const sessionMax = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.sessionMax);
  const weekUsed = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.weekUsed);
  const weekMax = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.weekMax);
  const sessionResetAt = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.sessionResetAt);
  const weekResetAt = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.weekResetAt);
  const source = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.source);
  if (!isOauthUsageSettingsSource(source)) return null;
  const subscriptionType = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.subscriptionType);
  const rateLimitTier = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.rateLimitTier);

  if (!Number.isFinite(sessionUsed) || !Number.isFinite(sessionMax) || !Number.isFinite(weekUsed) || !Number.isFinite(weekMax)) {
    return null;
  }

  const makeWindow = (key, label, durationMs, usedTokens, limitTokens, resetAt) => {
    const remainingTokens = Math.max(0, limitTokens - usedTokens);
    const utilizationPct = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : null;
    return {
      key,
      label,
      durationMs,
      utilizationPct,
      usageUnit: "tokens",
      usedTokens,
      limitTokens,
      remainingTokens,
      remainingPct: utilizationPct == null ? null : Math.max(0, 100 - utilizationPct),
      exhausted: remainingTokens <= 0,
      resetAt: resetAt || null,
    };
  };

  return {
    provider: "claude",
    source,
    subscriptionType,
    rateLimitTier,
    windows: [
      makeWindow("session", "Session (5h)", 5 * 60 * 60 * 1000, sessionUsed, sessionMax, sessionResetAt),
      makeWindow("week", "Week (7d)", 7 * 24 * 60 * 60 * 1000, weekUsed, weekMax, weekResetAt),
    ],
    fetchedAt: new Date(lastUpdated).toISOString(),
    cached: true,
    stale: allowStale && nowMs - lastUpdated > claudeUsageCacheMs(),
  };
}

function persistClaudeUsageSummaryToSettings(summary, nowMs = Date.now()) {
  if (!summary || !Array.isArray(summary.windows)) return;
  const session = summary.windows.find((window) => window.key === "session");
  const week = summary.windows.find((window) => window.key === "week");
  if (!session || !week) return;
  if (!Number.isFinite(session.usedTokens) || !Number.isFinite(session.limitTokens)) return;
  if (!Number.isFinite(week.usedTokens) || !Number.isFinite(week.limitTokens)) return;

  try {
    setAccountSettings({
      [CLAUDE_USAGE_SETTING_KEYS.sessionUsed]: String(session.usedTokens),
      [CLAUDE_USAGE_SETTING_KEYS.sessionMax]: String(session.limitTokens),
      [CLAUDE_USAGE_SETTING_KEYS.sessionResetAt]: session.resetAt || null,
      [CLAUDE_USAGE_SETTING_KEYS.weekUsed]: String(week.usedTokens),
      [CLAUDE_USAGE_SETTING_KEYS.weekMax]: String(week.limitTokens),
      [CLAUDE_USAGE_SETTING_KEYS.weekResetAt]: week.resetAt || null,
      [CLAUDE_USAGE_SETTING_KEYS.subscriptionType]: summary.subscriptionType || null,
      [CLAUDE_USAGE_SETTING_KEYS.rateLimitTier]: summary.rateLimitTier || null,
      [CLAUDE_USAGE_SETTING_KEYS.source]: summary.source || "anthropic-oauth-usage-api",
      [CLAUDE_USAGE_SETTING_KEYS.lastUpdated]: String(nowMs),
    });
  } catch (err) {
    if (isAccountSettingsBusyError(err)) return;
    throw err;
  }
}

function readClaudeUsageDiskCache(configDir = getClaudeConfigDir()) {
  const cachePath = getClaudeUsageCachePath(configDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.configDir && path.resolve(parsed.configDir) !== path.resolve(configDir)) return null;
    if (!parsed.summary || typeof parsed.summary !== "object") return null;
    return {
      cachedAt: Number(parsed.cachedAt) || 0,
      nextRetryAt: Number(parsed.nextRetryAt) || 0,
      configDir,
      summary: parsed.summary,
    };
  } catch {
    return null;
  }
}

function writeClaudeUsageDiskCache(configDir = getClaudeConfigDir(), entry = null) {
  const cachePath = getClaudeUsageCachePath(configDir);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    if (!entry) {
      if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      return;
    }
    fs.writeFileSync(cachePath, JSON.stringify({
      cachedAt: entry.cachedAt || Date.now(),
      nextRetryAt: entry.nextRetryAt || 0,
      configDir,
      summary: entry.summary || null,
    }, null, 2), "utf8");
  } catch {
    // Best-effort cache only.
  }
}

function hasUsableClaudeOauthToken(credentials, nowMs = Date.now()) {
  const token = String(credentials?.oauthToken || "").trim();
  if (!token) return false;
  const expiresAt = credentials?.expiresAt ? Date.parse(credentials.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
  return true;
}

function readClaudeLimitSetting(key) {
  const globalVal = getAccountSetting(key);
  if (globalVal != null && String(globalVal).trim() !== "") {
    const parsed = parseInt(String(globalVal).trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

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

function getClaudeUsageLimits() {
  return {
    session: readClaudeLimitSetting("claude_limit_tokens_session"),
    week: readClaudeLimitSetting("claude_limit_tokens_week"),
  };
}

function listClaudeUsageFiles(dir) {
  const files = [];
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }

  return files;
}

function summarizeClaudeUsageEntries(entries, nowMs, limits) {
  const windows = CLAUDE_USAGE_WINDOW_DEFS.map((def) => {
    const cutoff = nowMs - def.durationMs;
    const matching = entries.filter((entry) => entry.timestampMs >= cutoff);
    const usedTokens = matching.reduce((sum, entry) => sum + entry.totalTokens, 0);
    const oldestTs = matching.reduce((min, entry) => Math.min(min, entry.timestampMs), Number.POSITIVE_INFINITY);
    const limitTokens = limits[def.key] ?? null;
    const remainingTokens = limitTokens == null ? null : Math.max(0, limitTokens - usedTokens);
    const resetAt = Number.isFinite(oldestTs) ? new Date(oldestTs + def.durationMs).toISOString() : null;

    return {
      key: def.key,
      label: def.label,
      durationMs: def.durationMs,
      usedTokens,
      limitTokens,
      remainingTokens,
      resetAt,
    };
  });

  return windows;
}

function buildUsageWindowFromUtilization({
  key,
  label,
  durationMs,
  utilizationPct,
  resetAt,
  limitTokens = null,
}) {
  const pct = Number.isFinite(utilizationPct) ? Math.min(100, Math.max(0, utilizationPct)) : 0;
  const ratio = pct / 100;
  const usedTokens = limitTokens != null ? Math.round(limitTokens * ratio) : null;
  const remainingTokens = limitTokens != null ? Math.max(0, limitTokens - usedTokens) : null;
  return {
    key,
    label,
    durationMs,
    utilizationPct: pct,
    usageUnit: limitTokens != null ? "tokens" : "percent",
    usedTokens,
    limitTokens,
    remainingTokens,
    remainingPct: Math.max(0, 100 - pct),
    exhausted: pct >= 100 || (limitTokens != null && remainingTokens <= 0),
    resetAt: resetAt || null,
  };
}

function enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs) {
  if (!summary || !Array.isArray(summary.windows) || summary.windows.length === 0) return summary;
  const targets = summary.windows.filter((w) =>
    (w?.key === "session" || w?.key === "week") &&
    Number.isFinite(w.utilizationPct) &&
    (w.usedTokens == null || w.limitTokens == null)
  );
  if (targets.length === 0) return summary;

  let entries;
  try {
    entries = loadClaudeUsageEntries(configDir, nowMs);
  } catch {
    return summary;
  }
  if (!Array.isArray(entries) || entries.length === 0) return summary;

  const localByKey = new Map(
    summarizeClaudeUsageEntries(entries, nowMs, {}).map((w) => [w.key, w])
  );

  for (const win of targets) {
    const local = localByKey.get(win.key);
    const used = local?.usedTokens;
    if (!Number.isFinite(used) || used <= 0) continue;
    if (win.usedTokens == null) win.usedTokens = used;
    if (win.limitTokens == null && win.utilizationPct > 0) {
      const inferred = Math.max(used, Math.ceil(used / (win.utilizationPct / 100)));
      if (Number.isFinite(inferred) && inferred > 0) {
        win.limitTokens = inferred;
        win.limitSource = "inferred_percent";
        win.usageUnit = "tokens";
        win.remainingTokens = Math.max(0, inferred - win.usedTokens);
        win.remainingPct = Math.max(0, 100 - win.utilizationPct);
        win.exhausted = win.remainingTokens <= 0;
      }
    } else if (win.limitTokens != null) {
      win.remainingTokens = Math.max(0, win.limitTokens - win.usedTokens);
    }
  }

  return summary;
}

function normalizeClaudeOauthUsageResponse(payload, nowMs, limits) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const windows = [];
  const addWindow = (key, label, durationMs, period, limitTokens = null) => {
    if (!period || typeof period !== "object") return;
    const utilizationPct = Number(period.utilization);
    if (!Number.isFinite(utilizationPct)) return;
    windows.push(buildUsageWindowFromUtilization({
      key,
      label,
      durationMs,
      utilizationPct,
      resetAt: period.resets_at || period.resetAt || null,
      limitTokens,
    }));
  };

  addWindow("session", "Session (5h)", 5 * 60 * 60 * 1000, raw.five_hour, limits.session ?? null);
  addWindow("week", "Week (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day, limits.week ?? null);
  addWindow("week_sonnet", "Week Sonnet (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day_sonnet, null);
  addWindow("week_opus", "Week Opus (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day_opus, null);

  if (raw.extra_usage && typeof raw.extra_usage === "object") {
    const amountUsed = Number(raw.extra_usage.amount_used);
    const limit = Number(raw.extra_usage.limit);
    windows.push({
      key: "extra",
      label: "Extra Usage",
      durationMs: null,
      usageUnit: "currency",
      usedAmount: Number.isFinite(amountUsed) ? amountUsed : null,
      limitAmount: Number.isFinite(limit) ? limit : null,
      remainingAmount: Number.isFinite(amountUsed) && Number.isFinite(limit) ? Math.max(0, limit - amountUsed) : null,
      enabled: !!raw.extra_usage.is_enabled,
      exhausted: !!raw.extra_usage.is_enabled && Number.isFinite(amountUsed) && Number.isFinite(limit) ? amountUsed >= limit : false,
      resetAt: null,
    });
  }

  return {
    provider: "claude",
    source: "anthropic-oauth-usage-api",
    subscriptionType: raw.subscription_type || raw.subscriptionType || null,
    rateLimitTier: raw.rate_limit_tier || raw.rateLimitTier || null,
    windows,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

async function fetchClaudeOauthUsageAsync({ credentials, nowMs = Date.now(), timeoutMs = 8_000 }) {
  if (!hasUsableClaudeOauthToken(credentials, nowMs)) return null;
  const controller = new AbortController();
  const resolvedTimeoutMs = Math.max(1_000, Number(timeoutMs) || 8_000);
  const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  timeout.unref?.();
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${credentials.oauthToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Claude usage API returned ${res.status}${body ? `: ${body}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function cloneUsageSummary(summary) {
  return {
    ...summary,
    windows: Array.isArray(summary?.windows) ? summary.windows.map((window) => ({ ...window })) : [],
  };
}

function getCachedClaudeUsageSummary(configDir, nowMs, opts = {}) {
  const options = typeof opts === "boolean" ? { forceRefresh: opts } : (opts || {});
  const forceRefresh = !!options.forceRefresh;
  const ignoreBackoff = !!options.ignoreBackoff;
  if (
    !_usageApiCache ||
    _usageApiCache.configDir !== configDir ||
    !Array.isArray(_usageApiCache.summary?.windows)
  ) {
    const diskCache = readClaudeUsageDiskCache(configDir);
    if (diskCache) _usageApiCache = diskCache;
  }

  const cacheInBackoff =
    _usageApiCache &&
    _usageApiCache.configDir === configDir &&
    _usageApiCache.nextRetryAt &&
    nowMs < _usageApiCache.nextRetryAt;

  if (
    _usageApiCache &&
    _usageApiCache.configDir === configDir &&
    (
      (cacheInBackoff && !ignoreBackoff) ||
      (!forceRefresh && nowMs - _usageApiCache.cachedAt <= claudeUsageCacheMs())
    )
  ) {
    return cloneUsageSummary(_usageApiCache.summary);
  }

  return null;
}

function getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh = false) {
  if (
    !forceRefresh &&
    _usageSummaryCache &&
    _usageSummaryCache.configDir === configDir &&
    nowMs - _usageSummaryCache.cachedAt <= claudeUsageCacheMs()
  ) {
    return {
      ..._usageSummaryCache.summary,
      windows: summarizeClaudeUsageEntries(_usageSummaryCache.entries, nowMs, limits),
    };
  }

  return null;
}

export async function refreshUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false, timeoutMs = 8_000 } = {}) {
  const configDir = getClaudeConfigDir();
  const limits = getClaudeUsageLimits();
  const credentials = readClaudeCredentials(configDir);
  if (!forceRefresh) {
    const settingsCached = buildClaudeUsageSummaryFromSettings(nowMs);
    if (settingsCached) return settingsCached;
  }
  const cached = getCachedClaudeUsageSummary(configDir, nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  if (hasUsableClaudeOauthToken(credentials, nowMs)) {
    const fetchImpl = globalThis.__posseFetchClaudeOauthUsageAsync || fetchClaudeOauthUsageAsync;
    try {
      const payload = await fetchImpl({ credentials, nowMs, timeoutMs });
      if (payload) {
        const summary = normalizeClaudeOauthUsageResponse(payload, nowMs, limits);
        enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs);
        if (!summary.subscriptionType) summary.subscriptionType = credentials.subscriptionType;
        if (!summary.rateLimitTier) summary.rateLimitTier = credentials.rateLimitTier;
        _usageApiCache = {
          cachedAt: nowMs,
          configDir,
          summary,
          nextRetryAt: 0,
        };
        persistClaudeUsageSummaryToSettings(summary, nowMs);
        writeClaudeUsageDiskCache(configDir, _usageApiCache);
        return cloneUsageSummary(summary);
      }
    } catch (err) {
      const message = String(err?.message || err || "");
      const rateLimited = /\b429\b|rate.?limit/i.test(message);
      const staleSettingsSummary = buildClaudeUsageSummaryFromSettings(nowMs, { allowStale: true });
      const fallbackSummary = (
        _usageApiCache &&
        _usageApiCache.configDir === configDir &&
        Array.isArray(_usageApiCache.summary?.windows) &&
        _usageApiCache.summary.windows.length > 0
      )
        ? {
            ..._usageApiCache.summary,
            stale: true,
            source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
            detail: message || null,
          }
        : (
          staleSettingsSummary &&
          Array.isArray(staleSettingsSummary.windows) &&
          staleSettingsSummary.windows.length > 0
        )
          ? {
              ...staleSettingsSummary,
              stale: true,
              source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
              detail: message || null,
            }
        : buildClaudeOauthUnavailableSummary(
            credentials,
            nowMs,
            rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
            message || null
          );

      enrichClaudeOauthSummaryWithLocalTokens(fallbackSummary, configDir, nowMs);

      _usageApiCache = {
        cachedAt: nowMs,
        configDir,
        summary: fallbackSummary,
        nextRetryAt: nowMs + claudeUsageBackoffMs(),
      };
      writeClaudeUsageDiskCache(configDir, _usageApiCache);

      if (!isDeprecatedClaudeLogUsageEnabled()) return cloneUsageSummary(fallbackSummary);
    }
  }

  if (!isDeprecatedClaudeLogUsageEnabled()) {
    return buildClaudeOauthUnavailableSummary(credentials, nowMs);
  }

  const cachedDeprecated = getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh);
  if (cachedDeprecated) return cachedDeprecated;

  const entries = loadClaudeUsageEntries(configDir, nowMs);
  const summary = {
    provider: "claude",
    source: "claude-local-project-logs-deprecated",
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: summarizeClaudeUsageEntries(entries, nowMs, limits),
    deprecatedFallbackAvailable: true,
    deprecatedFallbackEnabled: true,
  };

  _usageSummaryCache = {
    cachedAt: nowMs,
    configDir,
    entries,
    summary: {
      provider: summary.provider,
      source: summary.source,
      subscriptionType: summary.subscriptionType,
      rateLimitTier: summary.rateLimitTier,
      deprecatedFallbackAvailable: true,
      deprecatedFallbackEnabled: true,
    },
  };

  return cloneUsageSummary(summary);
}

function buildClaudeOauthUnavailableSummary(credentials, nowMs, source = null, detail = null) {
  return {
    provider: "claude",
    source: source || (hasUsableClaudeOauthToken(credentials, nowMs)
      ? "anthropic-oauth-usage-api-unavailable"
      : "anthropic-oauth-usage-api-unconfigured"),
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: [],
    detail: detail ? String(detail) : null,
  };
}

function loadClaudeUsageEntries(configDir, nowMs) {
  const projectsDir = path.join(configDir, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const weekWindow = CLAUDE_USAGE_WINDOW_DEFS.find((def) => def.key === "week")?.durationMs || (7 * 24 * 60 * 60 * 1000);
  const oldestRelevantMs = nowMs - weekWindow;
  const entryMap = new Map();
  const seenFiles = new Set();

  for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(projectsDir, projectEntry.name);

    for (const filePath of listClaudeUsageFiles(projectPath)) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      seenFiles.add(filePath);
      if (stat.mtimeMs < oldestRelevantMs) continue;

      const cached = _usageFileCache.get(filePath);
      let fileEntries = null;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        fileEntries = cached.entries;
      } else {
        let raw;
        try {
          raw = fs.readFileSync(filePath, "utf8");
        } catch {
          continue;
        }

        const fileEntryMap = new Map();
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const usage = parsed?.message?.usage;
          const timestamp = parsed?.timestamp;
          if (!usage || !timestamp) continue;

          const timestampMs = Date.parse(timestamp);
          if (!Number.isFinite(timestampMs) || timestampMs < oldestRelevantMs) continue;

          const totalTokens =
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.output_tokens || 0);

          if (totalTokens <= 0) continue;

          const messageId = parsed?.message?.id || parsed?.requestId || parsed?.uuid || `${filePath}:${timestamp}`;
          const existing = fileEntryMap.get(messageId);
          if (!existing) {
            fileEntryMap.set(messageId, { messageId, timestampMs, totalTokens });
            continue;
          }

          if (totalTokens > existing.totalTokens) existing.totalTokens = totalTokens;
          if (timestampMs > existing.timestampMs) existing.timestampMs = timestampMs;
        }

        fileEntries = Array.from(fileEntryMap.values());
        _usageFileCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: fileEntries,
        });
      }

      for (const entry of fileEntries) {
        if (!entry || entry.timestampMs < oldestRelevantMs) continue;
        const entryKey = `${filePath}:${entry.messageId || `${entry.timestampMs}:${entry.totalTokens}`}`;
        entryMap.set(entryKey, entry);
      }
    }
  }

  for (const filePath of Array.from(_usageFileCache.keys())) {
    if (!seenFiles.has(filePath)) _usageFileCache.delete(filePath);
  }

  return Array.from(entryMap.values());
}

export function getUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false } = {}) {
  const configDir = getClaudeConfigDir();
  const limits = getClaudeUsageLimits();
  const credentials = readClaudeCredentials(configDir);
  if (!forceRefresh) {
    const settingsCached = buildClaudeUsageSummaryFromSettings(nowMs);
    if (settingsCached) return settingsCached;
  }
  const cached = getCachedClaudeUsageSummary(configDir, nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  if (hasUsableClaudeOauthToken(credentials, nowMs)) {
    const fetchImpl = globalThis.__posseFetchClaudeOauthUsage;
    try {
      const payload = typeof fetchImpl === "function" ? fetchImpl({ credentials, nowMs }) : null;
      if (payload) {
        const summary = normalizeClaudeOauthUsageResponse(payload, nowMs, limits);
        enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs);
        if (!summary.subscriptionType) summary.subscriptionType = credentials.subscriptionType;
        if (!summary.rateLimitTier) summary.rateLimitTier = credentials.rateLimitTier;
        _usageApiCache = {
          cachedAt: nowMs,
          configDir,
          summary,
          nextRetryAt: 0,
        };
        persistClaudeUsageSummaryToSettings(summary, nowMs);
        writeClaudeUsageDiskCache(configDir, _usageApiCache);
        return cloneUsageSummary(summary);
      }
    } catch (err) {
      const message = String(err?.message || err || "");
      const rateLimited = /\b429\b|rate.?limit/i.test(message);
      const staleSettingsSummary = buildClaudeUsageSummaryFromSettings(nowMs, { allowStale: true });
      const fallbackSummary = (
        _usageApiCache &&
        _usageApiCache.configDir === configDir &&
        Array.isArray(_usageApiCache.summary?.windows) &&
        _usageApiCache.summary.windows.length > 0
      )
        ? {
            ..._usageApiCache.summary,
            stale: true,
            source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
            detail: message || null,
          }
        : (
          staleSettingsSummary &&
          Array.isArray(staleSettingsSummary.windows) &&
          staleSettingsSummary.windows.length > 0
        )
          ? {
              ...staleSettingsSummary,
              stale: true,
              source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
              detail: message || null,
            }
        : buildClaudeOauthUnavailableSummary(
            credentials,
            nowMs,
            rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
            message || null
          );

      enrichClaudeOauthSummaryWithLocalTokens(fallbackSummary, configDir, nowMs);

      _usageApiCache = {
        cachedAt: nowMs,
        configDir,
        summary: fallbackSummary,
        nextRetryAt: nowMs + claudeUsageBackoffMs(),
      };
      writeClaudeUsageDiskCache(configDir, _usageApiCache);

      if (!isDeprecatedClaudeLogUsageEnabled()) {
        return cloneUsageSummary(fallbackSummary);
      }
    }
  }

  if (!isDeprecatedClaudeLogUsageEnabled()) {
    return buildClaudeOauthUnavailableSummary(credentials, nowMs);
  }

  const cachedDeprecated = getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh);
  if (cachedDeprecated) return cachedDeprecated;

  const entries = loadClaudeUsageEntries(configDir, nowMs);
  const summary = {
    provider: "claude",
    source: "claude-local-project-logs-deprecated",
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: summarizeClaudeUsageEntries(entries, nowMs, limits),
    deprecatedFallbackAvailable: true,
    deprecatedFallbackEnabled: true,
  };

  _usageSummaryCache = {
    cachedAt: nowMs,
    configDir,
    entries,
    summary: {
      provider: summary.provider,
      source: summary.source,
      subscriptionType: summary.subscriptionType,
      rateLimitTier: summary.rateLimitTier,
    },
  };

  return summary;
}

// ─── Token Usage Parsing ─────────────────────────────────────────────────────

/**
 * Parse token usage from Claude CLI stderr output.
 * Claude Code prints usage stats to stderr in various formats.
 * Returns { input: number|null, output: number|null }.
 */
function parseTokenUsage(stderr) {
  const result = { input: null, output: null };
  if (!stderr) return result;

  // Strip ANSI codes for reliable matching
  const clean = stripAnsi(stderr);

  // Pattern: "Input tokens: 12,345" or "input: 12345"
  const inputMatch = clean.match(/input\s*(?:tokens)?[:\s]+([0-9,]+)/i);
  if (inputMatch) result.input = parseInt(inputMatch[1].replace(/,/g, ""), 10);

  // Pattern: "Output tokens: 4,567" or "output: 4567"
  const outputMatch = clean.match(/output\s*(?:tokens)?[:\s]+([0-9,]+)/i);
  if (outputMatch) result.output = parseInt(outputMatch[1].replace(/,/g, ""), 10);

  // Pattern: "Total tokens: 16,912" with "Input: 12,345 / Output: 4,567"
  if (!result.input || !result.output) {
    const slashMatch = clean.match(/input[:\s]+([0-9,]+)\s*[/|]\s*output[:\s]+([0-9,]+)/i);
    if (slashMatch) {
      if (!result.input) result.input = parseInt(slashMatch[1].replace(/,/g, ""), 10);
      if (!result.output) result.output = parseInt(slashMatch[2].replace(/,/g, ""), 10);
    }
  }

  return result;
}

function _usageNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function _extractStreamUsage(resultData) {
  const candidates = [
    resultData?.usage,
    resultData?.result?.usage,
    resultData?.message?.usage,
    resultData?.final?.usage,
  ];
  for (const usage of candidates) {
    if (!usage || typeof usage !== "object") continue;
    if (
      usage.input_tokens != null
      || usage.output_tokens != null
      || usage.cache_creation_input_tokens != null
      || usage.cache_read_input_tokens != null
    ) {
      return usage;
    }
  }
  return {};
}

export function __testExtractClaudeSessionHandleFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const directKeys = [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const key of directKeys) {
    const value = msg[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nestedCandidates = [
    msg.session,
    msg.conversation,
    msg.result,
    msg.message,
    msg.metadata,
  ];
  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const nested = __testExtractClaudeSessionHandleFromStreamMessage(candidate);
    if (nested) return nested;
  }
  return null;
}

function isClaudeResumeHandleExpiredError(text) {
  return /no\s+(?:session|conversation|resume)(?:\s+\w+)*\s+found|(?:session|conversation|resume).*(?:not\s+found|unknown|invalid|expired)|(?:not\s+found|unknown|invalid|expired).*(?:session|conversation|resume)/i
    .test(String(text || ""));
}

export function __testIsClaudeResumeHandleExpiredError(text) {
  return isClaudeResumeHandleExpiredError(text);
}

function estimateTokensFromText(text) {
  const length = String(text || "").length;
  if (length <= 0) return null;
  return Math.max(1, Math.ceil(length / 4));
}

function buildClaudeInteractiveArgs(args = []) {
  const next = [];
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--dangerously-skip-permissions" || arg === "--allow-dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--permission-mode") {
      hasPermissionMode = true;
      next.push(arg);
      if (i + 1 < args.length) next.push(String(args[++i]));
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      hasPermissionMode = true;
    }
    next.push(arg);
  }
  if (!hasPermissionMode) next.push("--permission-mode", "dontAsk");
  return next;
}

export function __testBuildClaudeInteractiveArgs(args = []) {
  return buildClaudeInteractiveArgs(args);
}

function pathsEquivalent(left, right) {
  if (!left || !right) return false;
  try {
    return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
  } catch {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }
}

function getClaudeProjectSlugForCwd(cwd) {
  return path.resolve(cwd || process.cwd())
    .replaceAll(":", "-")
    .replaceAll("\\", "-")
    .replaceAll("/", "-");
}

function getClaudeProjectDirForCwd(cwd) {
  return path.join(getClaudeConfigDir(), "projects", getClaudeProjectSlugForCwd(cwd));
}

export function __testGetClaudeProjectDirForCwd(cwd) {
  return getClaudeProjectDirForCwd(cwd);
}

function readJsonFileQuiet(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listClaudeProjectLogFiles(cwd, { sinceMs = 0, sessionId = null } = {}) {
  const dir = getClaudeProjectDirForCwd(cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const minMtime = Math.max(0, Number(sinceMs || 0) - 10_000);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        return {
          file,
          sessionId: entry.name.slice(0, -".jsonl".length),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => {
      if (sessionId && entry.sessionId === sessionId) return true;
      return entry.mtimeMs >= minMtime;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findClaudeProjectLogFile(cwd, opts = {}) {
  return listClaudeProjectLogFiles(cwd, opts)[0] || null;
}

function readFileUtf8FromOffset(filePath, offset = 0) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: "", size: 0, mtimeMs: 0 };
  }
  const start = Math.min(stat.size, Math.max(0, Math.floor(Number(offset) || 0)));
  const length = Math.max(0, stat.size - start);
  if (length <= 0) return { text: "", size: stat.size, mtimeMs: stat.mtimeMs };
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { text: "", size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractClaudeTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ((part.type == null || part.type === "text") && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseClaudeInteractiveLogSince(logPath, offset = 0) {
  const read = readFileUtf8FromOffset(logPath, offset);
  const assistantTexts = [];
  let turnFinished = false;
  let sessionId = null;
  let usage = {};
  for (const line of read.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      sessionId = entry.sessionId.trim();
    }
    if (entry.type === "assistant") {
      const text = extractClaudeTextContent(entry.message?.content ?? entry.content).trim();
      if (text) assistantTexts.push(text);
      if (entry.message?.usage && typeof entry.message.usage === "object") usage = entry.message.usage;
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      turnFinished = true;
    }
  }
  return {
    output: assistantTexts.join("\n").trim(),
    assistantTextCount: assistantTexts.length,
    turnFinished,
    sessionId,
    usage,
    size: read.size,
    mtimeMs: read.mtimeMs,
  };
}

export function __testParseClaudeInteractiveLogSince(logPath, offset = 0) {
  return parseClaudeInteractiveLogSince(logPath, offset);
}

async function writeClaudeInteractivePrompt(session, prompt) {
  const text = String(prompt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Bracketed paste: without it the TUI treats every embedded \n as Enter and
  // submits the prompt piecemeal. The settle delays before each Enter remain —
  // the TUI needs time to ingest a large paste before it accepts the submit.
  // Strip any embedded end-paste marker so prompt content can't close paste
  // mode early and have its tail interpreted as terminal input.
  const pasteSafe = text.replace(/\x1b\[201~/g, "");
  session.write(`\x1b[200~${pasteSafe}\x1b[201~`);
  await sleepInteractiveMs(1_000);
  session.write("\r");
  await sleepInteractiveMs(1_000);
  session.write("\r");
}

function findClaudeInteractiveSessionState({ cwd, sessionId = null, pid = null, sinceMs = 0 } = {}) {
  const dir = path.join(getClaudeConfigDir(), "sessions");
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const minTime = Math.max(0, Number(sinceMs || 0) - 10_000);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const state = readJsonFileQuiet(file);
    if (!state || state.kind !== "interactive") continue;
    const stateSessionId = typeof state.sessionId === "string" ? state.sessionId.trim() : "";
    const statePid = Number(state.pid);
    const updatedAt = Number(state.updatedAt || state.startedAt || 0);
    // A known-mismatched identity disqualifies outright: with concurrent
    // interactive sessions (same cwd, overlapping recency) another session's
    // state file must never outrank the absence of our own. A sessionId match
    // overrides a pid mismatch — on Windows the spawned pid can be a .cmd
    // shim's, not the CLI's own.
    const sessionIdMatches = !!sessionId && !!stateSessionId && stateSessionId === sessionId;
    if (sessionId && stateSessionId && !sessionIdMatches) continue;
    if (!sessionIdMatches
      && Number.isFinite(pid) && pid > 0
      && Number.isFinite(statePid) && statePid > 0
      && statePid !== pid) continue;
    let score = 0;
    if (sessionId && stateSessionId === sessionId) score += 100;
    if (Number.isFinite(pid) && pid > 0 && statePid === pid) score += 50;
    if (cwd && pathsEquivalent(state.cwd, cwd)) score += 25;
    if (updatedAt >= minTime) score += 5;
    if (score <= 0) continue;
    candidates.push({ ...state, file, _score: score, _updatedAt: updatedAt });
  }
  candidates.sort((a, b) => (b._score - a._score) || (b._updatedAt - a._updatedAt));
  return candidates[0] || null;
}

async function closeInteractiveSessionGracefully(session, { slashCommandsEnabled = true } = {}) {
  if (!slashCommandsEnabled) return;
  try {
    session.sendLine("/exit");
    await session.waitForQuiet({ quietMs: 300, timeoutMs: 1_500 }).catch(() => {});
  } catch {
    // Best-effort; close() below owns final process cleanup.
  }
}

function sleepInteractiveMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function claudeInteractiveSafetyPromptVisible(text) {
  return /quick\s*safety\s*check|do\s+you\s+trust|yes,\s*i\s+trust\s+this\s+folder|enter\s+to\s+confirm/i
    .test(stripTerminalControls(text));
}

function claudeInteractiveBypassPromptVisible(text) {
  const clean = stripTerminalControls(text);
  return /bypass\s*permissions\s*mode|yes,\s*i\s*accept|proceeding,\s*you\s*accept/i.test(clean);
}

function claudeInteractiveInputReady(text) {
  const clean = stripTerminalControls(text);
  return /(?:^|\n)>\s*(?:Try\b|["“]|$)|don'?t\s*ask\s*on|\/effort/i.test(clean);
}

async function answerClaudeInteractiveSafetyPrompt(session, { timeoutMs = 2_000 } = {}) {
  if (!claudeInteractiveSafetyPromptVisible(session.cleanTranscript())) return false;
  session.sendLine("");
  await session.waitForQuiet({
    quietMs: 500,
    timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
  }).catch(() => {});
  return true;
}

async function answerClaudeInteractiveBypassPrompt(session, { timeoutMs = 2_000 } = {}) {
  if (!claudeInteractiveBypassPromptVisible(session.cleanTranscript())) return false;
  session.write("\x1b[B\r");
  await session.waitForQuiet({
    quietMs: 500,
    timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
  }).catch(() => {});
  return true;
}

async function answerClaudeInteractiveStartupPrompt(session, { timeoutMs = 2_000 } = {}) {
  if (await answerClaudeInteractiveBypassPrompt(session, { timeoutMs })) return true;
  if (await answerClaudeInteractiveSafetyPrompt(session, { timeoutMs })) return true;
  return false;
}

async function prepareClaudeInteractiveSession(session, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 30_000));
  let startupPromptAnsweredAt = 0;
  while (Date.now() < deadline) {
    if (await answerClaudeInteractiveStartupPrompt(session, { timeoutMs })) {
      startupPromptAnsweredAt = Date.now();
      await sleepInteractiveMs(100);
      continue;
    }
    const state = findClaudeInteractiveSessionState({
      cwd: session.cwd,
      pid: session?.proc?.pid,
      sinceMs: session.startedAt,
    });
    const inputReady = claudeInteractiveInputReady(session.getTranscript());
    const stateStatus = String(state?.status || "").toLowerCase();
    const stateUpdatedAt = Number(state?.updatedAt || 0);
    // Only an identity-grade match (pid or sessionId, score >= 50) may break
    // readiness: a cwd+recency match can be a concurrent session that is idle
    // while ours is still on the trust/bypass dialog. Without an identity
    // match the quiet-transcript heuristic below carries readiness.
    const stateIsOurs = Number(state?._score || 0) >= 50;
    if (stateIsOurs && stateStatus === "idle" && stateUpdatedAt >= session.startedAt - 1_000 && (!startupPromptAnsweredAt || inputReady)) {
      break;
    }
    const clean = stripTerminalControls(session.getTranscript());
    const quietForMs = Date.now() - session.lastDataAt;
    const settleAfterStartupMs = startupPromptAnsweredAt ? 6_000 : 0;
    const settledAfterStartup = !startupPromptAnsweredAt || Date.now() - startupPromptAnsweredAt >= settleAfterStartupMs;
    if (clean.trim() && quietForMs >= 500 && settledAfterStartup && (!startupPromptAnsweredAt || inputReady)) {
      break;
    }
    await sleepInteractiveMs(100);
  }
  await session.waitForQuiet({
    quietMs: 300,
    timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
  }).catch(() => {});
}

async function waitForClaudeInteractiveCompletion({
  session,
  cwd,
  sinceMs,
  sentAt,
  timeoutMs,
  initialLog = null,
  initialOffset = 0,
  abortWait = null,
  onOutput = null,
} = {}) {
  const waitLoop = async () => {
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
    let logInfo = initialLog || null;
    let logPath = logInfo?.file || null;
    let logOffset = logPath ? Math.max(0, Number(initialOffset) || 0) : 0;
    let sessionId = logInfo?.sessionId || null;
    let lastOutput = "";
    let lastParsed = null;
    let lastState = null;

    while (Date.now() <= deadline) {
      const foundLog = findClaudeProjectLogFile(cwd, { sinceMs, sessionId });
      if (!logPath && foundLog) {
        logInfo = foundLog;
        logPath = foundLog.file;
        logOffset = 0;
        sessionId = foundLog.sessionId || sessionId;
      } else if (
        foundLog
        && foundLog.file !== logPath
        && (!sessionId || foundLog.sessionId === sessionId || foundLog.mtimeMs >= sentAt - 1_000)
      ) {
        logInfo = foundLog;
        logPath = foundLog.file;
        logOffset = 0;
        sessionId = foundLog.sessionId || sessionId;
      } else if (foundLog) {
        logInfo = foundLog;
      }

      if (logPath) {
        lastParsed = parseClaudeInteractiveLogSince(logPath, logOffset);
        if (lastParsed.sessionId) sessionId = lastParsed.sessionId;
        if (lastParsed.output && lastParsed.output !== lastOutput) {
          lastOutput = lastParsed.output;
          onOutput?.(lastOutput, lastParsed);
        }
      }

      lastState = findClaudeInteractiveSessionState({
        cwd,
        sessionId,
        pid: session?.proc?.pid,
        sinceMs,
      });

      const stateStatus = String(lastState?.status || "").toLowerCase();
      const stateUpdatedAt = Number(lastState?.updatedAt || 0);
      const idleAfterPrompt = stateStatus === "idle" && stateUpdatedAt >= sentAt - 1_000;
      const waitingFor = String(lastState?.waitingFor || "");
      if (stateStatus === "waiting" && /permission/i.test(waitingFor) && Date.now() - sentAt > 2_000) {
        const err = new Error(`Claude interactive session is waiting for permission prompt despite no-approval mode.`);
        err.code = "CLAUDE_INTERACTIVE_PERMISSION_PROMPT";
        err.sessionState = lastState;
        throw err;
      }

      if (lastOutput && (idleAfterPrompt || lastParsed?.turnFinished)) {
        return {
          output: lastOutput,
          logPath,
          sessionId,
          sessionState: lastState,
          usage: lastParsed?.usage || {},
          completedBy: idleAfterPrompt ? "session-idle" : "turn-duration",
        };
      }

      const logQuiet = lastParsed?.mtimeMs ? Date.now() - lastParsed.mtimeMs >= 1_500 : false;
      const terminalQuiet = session?.lastDataAt ? Date.now() - session.lastDataAt >= 1_500 : false;
      if (lastOutput && !lastState && logQuiet && terminalQuiet) {
        return {
          output: lastOutput,
          logPath,
          sessionId,
          sessionState: null,
          usage: lastParsed?.usage || {},
          completedBy: "log-quiet",
        };
      }

      await sleepInteractiveMs(250);
    }
    throw new Error(`Timed out after ${Math.max(1, Number(timeoutMs) || 1)}ms waiting for Claude interactive idle state.`);
  };

  if (!abortWait) return waitLoop();
  return Promise.race([waitLoop(), abortWait]);
}

async function runClaudeInteractiveProviderCall({
  args,
  prompt,
  cwd,
  env,
  timeoutMs,
  backend = null,
  abortSignal = null,
  onLine = null,
  directOutput = false,
  color = C.cyan,
  startTime = Date.now(),
} = {}) {
  const resolvedBackend = backend || getDefaultInteractiveCliBackend();
  if (!resolvedBackend) throw new InteractiveCliUnavailableError();

  const fullArgs = buildClaudeInteractiveArgs([...CLAUDE_ARGS, ...(Array.isArray(args) ? args : [])]);
  const session = new InteractiveCliSession({
    command: CLAUDE_CMD,
    args: fullArgs,
    cwd: cwd || process.cwd(),
    env,
    backend: resolvedBackend,
    timeoutMs,
    quietMs: 500,
    cols: 160,
    rows: 48,
  });
  let aborted = false;
  let abortError = null;
  let lastOutputLen = 0;
  let progressTimer = null;
  let rejectAbortWait = null;
  const abortWait = new Promise((_, reject) => {
    rejectAbortWait = reject;
  });
  abortWait.catch(() => {});

  const emitNewOutput = (output) => {
    const clean = String(output || "");
    const next = clean.slice(lastOutputLen);
    lastOutputLen = clean.length;
    const visible = next.trim();
    if (!visible) return;
    for (const line of visible.split(/\n/).map((entry) => entry.trimEnd()).filter(Boolean)) {
      if (directOutput) process.stdout.write(`${color}|${C.reset} ${line}\n`);
      else if (onLine) onLine(line);
    }
  };

  const onAbort = () => {
    aborted = true;
    abortError = new Error("Claude interactive session aborted");
    abortError.name = "AbortError";
    try { session.proc?.kill?.(); } catch {}
    rejectAbortWait?.(abortError);
  };

  try {
    session.start();
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    if (aborted) throw abortError;
    await prepareClaudeInteractiveSession(session, { timeoutMs: Math.min(timeoutMs, 30_000) });
    const promptLog = findClaudeProjectLogFile(session.cwd, { sinceMs: session.startedAt });
    const promptLogOffset = promptLog?.size || 0;
    const sentAt = Date.now();
    await writeClaudeInteractivePrompt(session, prompt);
    if (onLine || directOutput) {
      progressTimer = setInterval(() => {
        const logInfo = promptLog?.file
          ? { file: promptLog.file, sessionId: promptLog.sessionId }
          : findClaudeProjectLogFile(session.cwd, { sinceMs: session.startedAt });
        if (!logInfo?.file) return;
        const parsed = parseClaudeInteractiveLogSince(logInfo.file, promptLog?.file === logInfo.file ? promptLogOffset : 0);
        if (parsed.output) emitNewOutput(parsed.output);
      }, 500);
      progressTimer.unref?.();
    }
    const completed = await waitForClaudeInteractiveCompletion({
      session,
      cwd: session.cwd,
      sinceMs: session.startedAt,
      sentAt,
      timeoutMs,
      initialLog: promptLog,
      initialOffset: promptLogOffset,
      abortWait,
      onOutput: (output) => {
        if (onLine || directOutput) emitNewOutput(output);
      },
    });
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
      emitNewOutput(completed.output);
    }
    await session.waitForQuiet({ quietMs: 500, timeoutMs: Math.min(timeoutMs, 3_000) }).catch(() => {});
    const transcript = session.cleanTranscript();
    await closeInteractiveSessionGracefully(session, { slashCommandsEnabled: false });
    return {
      output: completed.output,
      transcript,
      sessionHandle: completed.sessionId || null,
      logPath: completed.logPath || null,
      completedBy: completed.completedBy || null,
      usage: completed.usage || {},
      durationMs: Date.now() - startTime,
      exitCode: 0,
      signal: null,
    };
  } catch (err) {
    if (progressTimer) clearInterval(progressTimer);
    const transcript = session.cleanTranscript();
    if (aborted && abortError) throw abortError;
    err.transcript = transcript;
    throw err;
  } finally {
    if (abortSignal) {
      try { abortSignal.removeEventListener("abort", onAbort); } catch {}
    }
    await session.close({ gracefulMs: 500 });
  }
}

function _extractClaudeToolUsesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const toolUses = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "tool_use" || typeof block.name !== "string" || !block.name.trim()) continue;
    toolUses.push({
      id: typeof block.id === "string" && block.id.trim() ? block.id.trim() : null,
      tool: block.name,
      input: block.input && typeof block.input === "object" ? block.input : null,
    });
  }
  return toolUses;
}

function _extractClaudeToolUsesFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return [];
  return [
    ..._extractClaudeToolUsesFromContent(msg.content),
    ..._extractClaudeToolUsesFromContent(msg.message?.content),
  ];
}

export function __testExtractClaudeToolUsesFromStreamMessage(msg) {
  assertTestContext("__testExtractClaudeToolUsesFromStreamMessage");
  return _extractClaudeToolUsesFromStreamMessage(msg);
}

function _estimateClaudeApiEquivalentCostUsd({ modelName, modelTier, usage = {}, stderrTokens = {} } = {}) {
  const rates = resolvePricing({ provider: "claude", modelName, modelTier });
  if (!rates || rates.source === "none") return null;
  const regularInput = Math.max(0, _usageNumberOrNull(usage.input_tokens) ?? stderrTokens.input ?? 0);
  const cacheCreationInput = Math.max(0, _usageNumberOrNull(usage.cache_creation_input_tokens) ?? 0);
  const cacheReadInput = Math.max(0, _usageNumberOrNull(usage.cache_read_input_tokens) ?? 0);
  const output = Math.max(0, _usageNumberOrNull(usage.output_tokens) ?? stderrTokens.output ?? 0);
  const billableInputUnits = regularInput + (cacheCreationInput * 1.25) + (cacheReadInput * 0.10);
  const cost = ((billableInputUnits * rates.inputPerM) + (output * rates.outputPerM)) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

// ─── Claude CLI Caller ──────────────────────────────────────────────────────

/**
 * Call Claude Code CLI with a prompt.
 *
 * Prompt is piped via stdin (no command-line length limits).
 * Returns { output, stats } where stats has timing, char counts, and model info.
 *
 * @param {string} promptText - The prompt to send
 * @param {object} opts
 * @param {string} opts.role - Worker role: 'researcher' | 'planner' | 'dev' | 'assessor'
 * @param {boolean} opts.allowWrite - Allow file writes (dev role)
 * @param {string} opts.modelTier - 'cheap' | 'standard' | 'strong'
 * @param {string} opts.reasoningEffort - 'low' | 'medium' | 'high' — controls thinking depth
 * @param {string} opts.activity - Short description for the header
 * @param {boolean} opts.silent - Suppress console output
 * @param {boolean} opts.autoApprove - Skip tool permission prompts
 * @param {number} opts.maxTurns - Override max turns for this call
 * @param {boolean} opts.deepthink - Raise planning/research turn budget for deep repo-wide analysis
 * @returns {Promise<{output: string, stats: object}>}
 */
export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
  modelTier = "standard",
  modelName = null,    // explicit per-job model from delegation; beats provider-wide default
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  autoApprove = false,
  scopedFiles = null,  // string[] — files_to_modify: Write/Edit scoped to these exact paths
  createFiles = null,  // string[] — files_to_create: Write scoped to these exact new file paths
  createRoots = null,  // string[] — directories where Write is allowed for any path under them
  readRoots = null,    // string[] — directories readable outside cwd, never writable
  deleteFiles = null,
  stableContext = null,
  remoteSystemPrompt = null,
  maxTurns = null,
  deepthink = false,
  complexity = null,   // 1-5 planner complexity score — drives dynamic turn budget for dev/artificer
  filesToModifyCount = null, // dev turn scaling input from planner scope size
  jobDir = null,       // per-job scratch dir noted in the prompt
  onLine = null,       // (line: string) => void — routes output lines externally (implies silent stdout)
  cwd = null,          // real repo / worktree — used for MCP workspace + git ops
  loaderCwd = null,    // optional empty dir to spawn the claude process in (suppresses parent-walk CLAUDE.md discovery). Falls back to cwd.
  mcpCwd = null,       // optional override for MCP workspace root. Falls back to cwd.
  projectDir = null,   // project root for runtime path resolution
  abortSignal = null,  // AbortSignal — when aborted, kills the child process
  stallTimeout = null, // Override stall timeout in seconds (default: 600)
  needsImageGeneration = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  skipRolePrompt = false,
  recyclingMode = "fresh",
  priorSessionHandle = null,
  recordFinalPrompt = null, // (finalPrompt, { systemPrompt?, systemPromptFiles? }) => void
  disableAtlas = false,
  atlasPrefetchStatus = null,
  atlasConfig = null,
  executionMode = null,
  interactiveBackend = null,
} = {}) {
  await ensureClaudeResolvedAsync();
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasMcp = await buildClaudeAtlasMcpConfigPayloadAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );
  return new Promise((resolve, reject) => {
    void (async () => {
    let cleanupAtlasMcpConfig = () => {};
    let cleanupRolePromptFile = () => {};
    let cleanupStablePromptFile = () => {};
    let cleanupSystemPromptFile = () => {};
    const cleanupSetupFiles = () => {
      cleanupAtlasMcpConfig();
      cleanupRolePromptFile();
      cleanupStablePromptFile();
      cleanupSystemPromptFile();
    };
    try {
    const args = [];
    const attachedSystemPromptFiles = [];
    const omitSessionPreamble = recyclingMode === "resume";
    const remoteSystemPromptText = omitSessionPreamble ? "" : String(remoteSystemPrompt || "").trim();

    const tierConfig = getModelTierConfig(modelTier);
    const modelToUse = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: tierConfig.model });
    if (modelToUse) {
      args.push("--model", modelToUse);
    }

    // ── Max turns ──────────────────────────────────────────────────────────
    const turns = maxTurns || getMaxTurns(role, modelTier, complexity, deepthink, filesToModifyCount);
    if (turns) {
      args.push("--max-turns", String(turns));
    }
    if (priorSessionHandle) {
      args.push("--resume", String(priorSessionHandle));
    }

    // Runtime agents must not load user/project settings. The per-job loader
    // cwd is empty by construction, so local is the only permitted source.
    args.push("--setting-sources", "local");
    args.push("--disable-slash-commands");
    args.push("--strict-mcp-config");

    const providerPaths = normalizeProviderPaths({ cwd, projectDir });
    const mcpWorkspaceCwd = mcpCwd ? path.resolve(mcpCwd) : providerPaths.cwd;
    const spawnCwd = loaderCwd ? path.resolve(loaderCwd) : providerPaths.cwd;
    const assignmentUnit = assignmentUnitForAtlas;
    const { attachment: atlasAttachment, payload: atlasMcpPayload } = preparedAtlasMcp;
    const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
    logAtlasAttachment({
      attachment: atlasAttachment,
      jobId,
      workItemId,
      providerName: "claude",
      role,
    });
    if (atlasAttachment.failClosed) {
      const err = new Error(
        `ATLAS required mode blocks ${role} on claude (${atlasAttachment.requiredFailureReason || "unavailable"}).`
      );
      err.code = "ATLAS_REQUIRED_BLOCKED";
      err.atlas = atlasAttachment;
      throw err;
    }
    const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
    const atlasReadyForMcp = hasProviderVisibleAtlasMcpTools({
      disableAtlas,
      atlasPrefetchStatus,
      atlasAttachment,
    });
    const disableSystemToolsResolved = resolveDisableSystemTools();
    const deterministicReadMcp = await buildClaudeDeterministicReadMcpConfigPayloadAsync(role, mcpWorkspaceCwd, {
      scopedFiles,
      createFiles,
      deleteFiles,
      createRoots,
      readRoots,
      needsImageGeneration,
      disableSystemTools: disableSystemToolsResolved,
      jobId,
      workItemId,
      attemptId,
      atlasPrefetchStatus,
      atlasAvailable: atlasReadyForMcp,
      atlasGateEnabled: atlasToolGateEnabled,
      atlasConfig,
    });
    const atlasServerName = deterministicReadMcp.active
      ? deterministicReadMcp.serverName
      : atlasMcpPayload?.serverName;
    const atlasContractTools = atlasReadyForMcp
      ? buildMcpAtlasSurfaceToolDescriptors(atlasAttachment.tools, {
        providerName: "claude",
        serverName: atlasServerName,
      })
      : [];
    const promptAtlasAttachment = atlasReadyForMcp
      ? { ...atlasAttachment, surfaceToolNames: buildSurfaceNameMap(atlasContractTools) }
      : { ...atlasAttachment, active: false, tools: [] };
    if (remoteSystemPromptText) {
      try {
        const rolePromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-role-"));
        const rolePromptPath = path.join(rolePromptDir, "remote-system.md");
        fs.writeFileSync(rolePromptPath, remoteSystemPromptText, "utf8");
        cleanupRolePromptFile = () => {
          try { fs.rmSync(rolePromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        attachedSystemPromptFiles.push(rolePromptPath);
      } catch (setupErr) {
        cleanupSetupFiles();
        throw setupErr;
      }
    }
    let executionContract = buildExecutionContract({
      provider: "claude",
      role,
      roleMode,
      allowWrite,
      scopedFiles,
      createFiles,
      createRoots,
      deleteFiles,
      readRoots,
      needsImageGeneration,
      platform: process.platform,
      includeBaseTools: !(deterministicReadMcp.active || disableSystemToolsResolved),
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    const cliToolConfig = buildClaudeCliToolConfig(executionContract, {
      autoApprove,
      scopedFiles,
      createFiles,
      createRoots,
      readRoots,
      scopeCwd: mcpWorkspaceCwd,
      deterministicReadMcpActive: deterministicReadMcp.active,
      disableSystemTools: disableSystemToolsResolved,
      webToolsEnabled: resolveWebToolsEnabled(),
    });
    if (cliToolConfig.tools != null) {
      args.push("--tools", cliToolConfig.tools);
    }
    if (cliToolConfig.disallowedTools) {
      args.push("--disallowedTools", cliToolConfig.disallowedTools);
    }
    if (cliToolConfig.allowedTools) {
      args.push("--allowedTools", cliToolConfig.allowedTools);
    } else if (cliToolConfig.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if ((role === "dev" && allowWrite) && !cliToolConfig.allowedTools && !cliToolConfig.dangerouslySkipPermissions) {
      throw new Error(
        `Dev role requires either file scope (scopedFiles/createFiles/createRoots) or autoApprove=true. ` +
        `Without one, tool calls block on permission prompts in headless mode.`
      );
    }
    if ((role === "artificer" && allowWrite) && !cliToolConfig.allowedTools && !cliToolConfig.dangerouslySkipPermissions && !(createRoots?.length > 0)) {
      throw new Error(`Artificer role requires either create_roots scope or autoApprove=true.`);
    }

    try {
      // The Posse MCP gateway exposes deterministic and atlas.* suites from a
      // single process, so do not attach a second ATLAS MCP server when the
      // gateway is already active.
      const atlasServedByGateway = !!deterministicReadMcp.active;
      const mergedMcpServers = {
        ...(deterministicReadMcp.payload?.mcpServers || {}),
        ...(atlasServedByGateway || !atlasReadyForMcp ? {} : (atlasMcpPayload?.mcpServers || {})),
      };
      logProviderMcpSurfaceTelemetry({
        providerName: "claude",
        role,
        workItemId,
        jobId,
        attemptId,
        deterministicReadMcp,
        atlasReadyForMcp,
        atlasContractTools,
        mcpServerNames: Object.keys(mergedMcpServers),
        cliToolConfig,
      });
      if (Object.keys(mergedMcpServers).length > 0) {
        const mcpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-"));
        cleanupAtlasMcpConfig = () => {
          try { fs.rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        const mcpConfigPath = path.join(mcpConfigDir, "claude-mcp-config.json");
        fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mergedMcpServers }, null, 2), "utf8");
        args.push("--mcp-config", mcpConfigPath);
      }
    } catch (setupErr) {
      cleanupSetupFiles();
      throw setupErr;
    }

    // ── Thinking / reasoning effort ─────────────────────────────────────
    // Three dimensions: tier.thinking (model capability), reasoningEffort (task need)
    //   high effort OR strong tier  → [ultrathink] deep reasoning prefix
    //   medium effort (default)     → no prefix (model's natural depth)
    //   low effort                  → conciseness prefix (skip analysis, just do it)
    const contractBlock = renderExecutionContractBlock(executionContract);
    const stablePromptText = omitSessionPreamble
      ? ""
      : [contractBlock, stableContext].filter(Boolean).join("\n\n");
    if (stablePromptText.trim()) {
      try {
        const stablePromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-system-"));
        const stablePromptPath = path.join(stablePromptDir, "execution-context.md");
        fs.writeFileSync(stablePromptPath, stablePromptText, "utf8");
        cleanupStablePromptFile = () => {
          try { fs.rmSync(stablePromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        attachedSystemPromptFiles.push(stablePromptPath);
      } catch (setupErr) {
        cleanupSetupFiles();
        throw setupErr;
      }
    }
    try {
      const systemPromptParts = [ISOLATED_SYSTEM_PROMPT];
      for (const filePath of attachedSystemPromptFiles) {
        try {
          const text = fs.readFileSync(filePath, "utf-8").trim();
          if (text) systemPromptParts.push(text);
        } catch {
          // Optional prompt files are best-effort; the isolation preamble
          // remains load-bearing even when a role has no extra prompt file.
        }
      }
      const systemPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-system-"));
      const systemPromptPath = path.join(systemPromptDir, "system.md");
      fs.writeFileSync(systemPromptPath, systemPromptParts.join("\n\n"), "utf8");
      cleanupSystemPromptFile = () => {
        try { fs.rmSync(systemPromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
      };
      args.push("--system-prompt-file", systemPromptPath);
    } catch (setupErr) {
      cleanupSetupFiles();
      throw setupErr;
    }
    const basePrompt = promptText;
    let finalPrompt = basePrompt;
    if (deepthink) {
      finalPrompt = `[ultrathink] Deep-think budget is enabled for this task. Take the extra time needed to inspect the codebase carefully and synthesize before concluding.\n\n${basePrompt}`;
    } else if (tierConfig.thinking || reasoningEffort === "high") {
      finalPrompt = `[ultrathink] This is a complex task requiring deep reasoning.\n\n${basePrompt}`;
    } else if (reasoningEffort === "low") {
      finalPrompt = `Be direct and efficient. Skip detailed analysis — just execute the task.\n\n${basePrompt}`;
    }

    // Log the fully-assembled user-message prompt (contract + thinking prefix
    // + handoff packet content) along with BOTH the paths of the system
    // prompt files AND their concatenated contents. Without the contents,
    // grepping the prompt log for role-prompt text (e.g. "You are the
    // researcher…") finds nothing, which looks identical to "the role
    // portion was dropped" even though the files are folded into a
    // Posse-owned --system-prompt-file at runtime.
    if (typeof recordFinalPrompt === "function") {
      let systemPromptInline = null;
      try {
        const parts = [ISOLATED_SYSTEM_PROMPT];
        for (const filePath of attachedSystemPromptFiles) {
          try { parts.push(fs.readFileSync(filePath, "utf-8").trim()); }
          catch { /* best effort — skip missing/unreadable files */ }
        }
        if (parts.length > 0) systemPromptInline = parts.join("\n\n");
      } catch { /* recording must never break the call */ }
      recordFinalPrompt(finalPrompt, {
        systemPrompt: systemPromptInline,
        systemPromptFiles: attachedSystemPromptFiles,
      });
    }

    // When onLine is set, suppress direct stdout (display handles output)
    const directOutput = !onLine && !silent;
    const selectedExecutionMode = resolveClaudeExecutionMode({ requested: executionMode, interactiveBackend });

    // Visual framing
    const color = roleBrandColor(role, C.cyan);
    const icon = roleBrandIcon(role);
    const showHeader = directOutput && role !== "assessor";

    const tierLabel = tierConfig ? ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}` : "";
    const effortLabel = reasoningEffort !== "medium" ? ` ${C.dim}effort:${reasoningEffort}${C.reset}` : "";
    const modelLabel = modelToUse ? ` ${C.dim}model:${modelToUse}${C.reset}` : "";
    const turnsLabel = turns ? ` ${C.dim}turns:${turns}${C.reset}` : "";
    const modeLabel = selectedExecutionMode !== CLAUDE_EXECUTION_MODE_PRINT ? ` ${C.dim}mode:${selectedExecutionMode}${C.reset}` : "";
    const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";

    if (showHeader) {
      console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
      console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${effortLabel}${modelLabel}${turnsLabel}${modeLabel}${actLabel}`);
      console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
    }

    const startTime = Date.now();
    const childEnv = scrubClaudeChildEnv(buildRuntimeEnv(providerPaths.projectDir, providerPaths.cwd, process.env));

    if (selectedExecutionMode === CLAUDE_EXECUTION_MODE_INTERACTIVE) {
      void (async () => {
        const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
        const baseTimeout = resolveProviderStallTimeout(stallTimeout);
        const timeoutMs = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;
        try {
          const result = await runClaudeInteractiveProviderCall({
            args,
            prompt: finalPrompt,
            cwd: spawnCwd,
            env: childEnv,
            timeoutMs,
            backend: interactiveBackend,
            abortSignal,
            onLine,
            directOutput,
            color,
            startTime,
          });
          cleanupSetupFiles();
          const durationMs = result.durationMs ?? (Date.now() - startTime);
          const output = String(result.output || "").trim();
          const interactiveUsage = result.usage && typeof result.usage === "object" ? result.usage : {};
          const hasInteractiveUsage = _usageNumberOrNull(interactiveUsage.input_tokens) != null
            || _usageNumberOrNull(interactiveUsage.output_tokens) != null
            || _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens) != null
            || _usageNumberOrNull(interactiveUsage.cache_read_input_tokens) != null;
          const estimatedInputTokens = _usageNumberOrNull(interactiveUsage.input_tokens) ?? estimateTokensFromText(finalPrompt);
          const estimatedOutputTokens = _usageNumberOrNull(interactiveUsage.output_tokens) ?? estimateTokensFromText(output);
          const estimatedUsage = {
            input_tokens: estimatedInputTokens,
            output_tokens: estimatedOutputTokens,
            cache_creation_input_tokens: _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens) ?? undefined,
          };
          const apiEquivalentCostUsd = _estimateClaudeApiEquivalentCostUsd({
            modelName: modelToUse,
            modelTier,
            usage: estimatedUsage,
          });
          if (onLine) {
            onLine(`${C.dim}completed: ${(durationMs / 1000).toFixed(1)}s | ${output.length} chars via interactive session${C.reset}`);
          }
          resolve({
            output,
            stats: {
              role,
              modelTier,
              reasoningEffort,
              modelName: modelToUse,
              promptChars: finalPrompt.length,
              outputChars: output.length,
              inputTokens: estimatedInputTokens,
              outputTokens: estimatedOutputTokens,
              cacheCreationInputTokens: _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens),
              cacheReadInputTokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens),
              cachedInputTokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens),
              reasoningOutputTokens: _usageNumberOrNull(interactiveUsage.thinking_tokens ?? interactiveUsage.reasoning_output_tokens),
              costUsd: apiEquivalentCostUsd,
              totalCostUsd: null,
              numTurns: null,
              durationMs,
              exitCode: result.exitCode,
              maxTurns: turns,
              toolUses: null,
              atlasMethod: atlasMethodForStats,
              sessionHandle: result.sessionHandle || null,
              priorSessionHandle: priorSessionHandle || null,
              sessionExpired: false,
              executionMode: CLAUDE_EXECUTION_MODE_INTERACTIVE,
              usageEstimated: !hasInteractiveUsage,
              interactiveCompletedBy: result.completedBy || null,
            },
          });
        } catch (err) {
          cleanupSetupFiles();
          const transcript = err?.transcript ? stripTerminalControls(err.transcript) : "";
          const timeoutText = /timed out/i.test(String(err?.message || ""));
          const preserveError = err?.name === "AbortError"
            || err instanceof InteractiveCliUnavailableError
            || err?.code === "INTERACTIVE_CLI_UNAVAILABLE";
          const wrapped = preserveError ? err : new Error(
            timeoutText
              ? `Claude interactive session timed out after ${timeoutMs / 1000}s waiting for idle state.`
              : `Claude interactive session failed: ${err?.message || err || "unknown error"}`
          );
          wrapped.code = wrapped.code || (timeoutText ? "CLAUDE_INTERACTIVE_TIMEOUT" : "CLAUDE_INTERACTIVE_FAILED");
          wrapped.stats = {
            role,
            modelTier,
            reasoningEffort,
            modelName: modelToUse,
            promptChars: finalPrompt.length,
            outputChars: transcript.length,
            durationMs: Date.now() - startTime,
            exitCode: null,
            maxTurns: turns,
            atlasMethod: atlasMethodForStats,
            priorSessionHandle: priorSessionHandle || null,
            sessionExpired: !!priorSessionHandle && isClaudeResumeHandleExpiredError(`${transcript}\n${wrapped.message}`),
            executionMode: CLAUDE_EXECUTION_MODE_INTERACTIVE,
          };
          wrapped.stdout = transcript || null;
          wrapped.partialOutput = transcript || null;
          reject(wrapped);
        }
      })();
      return;
    }

    // Prompt is piped via stdin to avoid Windows 32K command-line length limit.
    // "-p" puts Claude Code in print mode reading from stdin.
    // "--output-format stream-json" gives us streaming JSONL with token usage stats.
    const fullArgs = [...CLAUDE_ARGS, ...args, "-p", "--verbose", "--output-format", "stream-json"];

    let proc;
    try {
      const launch = buildWindowsSpawn(CLAUDE_CMD, fullArgs);
      proc = spawn(launch.command, launch.args, {
        cwd: spawnCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (spawnErr) {
      cleanupSetupFiles();
      throw spawnErr;
    }

    const forceKillTimers = new Set();
    const scheduleForceKill = () => {
      const timer = setTimeout(() => {
        forceKillTimers.delete(timer);
        terminateSpawnedProcess(proc, { force: true });
      }, 3000);
      timer.unref?.();
      forceKillTimers.add(timer);
    };
    const clearForceKillTimers = () => {
      for (const timer of forceKillTimers) clearTimeout(timer);
      forceKillTimers.clear();
    };

    // Abort handling — kill the child process when signal fires
    if (abortSignal) {
      const onAbort = () => {
        terminateSpawnedProcess(proc, { force: false });
        scheduleForceKill();
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => abortSignal.removeEventListener("abort", onAbort));
      }
    }

    // Write prompt to stdin and close
    proc.stdin.on("error", () => {}); // prevent EPIPE crash if child exits early
    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    let rawStdout = "";
    let stderr = "";
    let lineCount = 0;
    let gotFirstOutput = false;
    let killedByStallDetector = false;

    // Role-aware stall timeout: researchers/planners legitimately run longer
    // with little or no streaming output (thinking models, large codebases).
    const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
    const baseTimeout = resolveProviderStallTimeout(stallTimeout);
    const STALL_TIMEOUT = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;

    // stream-json state
    let jsonLineBuf = "";      // partial JSONL line buffer
    let fullOutput = "";       // accumulated text output from deltas
    let textLineBuf = "";      // buffer for assembling text lines from deltas
    // Hard cap on unbounded line buffers. A single JSONL message larger than
    // this is almost certainly a malformed stream (binary garbage from a
    // crashed child, or a line that never terminates) — drop it rather than
    // let memory grow without bound.
    const LINE_BUF_MAX = 16 * 1024 * 1024; // 16 MiB
    const toolUses = [];       // track tool calls: [{ tool, input }, ...]
    const seenToolUseKeys = new Set();
    let _pendingToolUse = null;  // current tool_use block from content_block_start
    let _pendingToolInput = "";  // accumulate input_json_delta for current tool
    let _lastChainReadPath = null; // remember so chain_verdict live log shows the file
    let resultData = null;     // final result message with usage stats
    let latestSessionHandle = null;

    function shouldShowPreResultToolTarget(displayName, target) {
      if (displayName === "list_files") return false;
      const normalized = String(target || "").replace(/\\/g, "/");
      if (!normalized) return false;
      if (normalized === "." || normalized === "src") return true;
      return !/(^|\/)\.(?:posse|git|claude|codex)(?:\/|$)/i.test(normalized);
    }

    function toolUseReplayKey(toolUse) {
      const id = typeof toolUse?.id === "string" && toolUse.id.trim() ? toolUse.id.trim() : null;
      if (id) return `id:${id}`;
      return `${toolUse?.tool || ""}\0${JSON.stringify(toolUse?.input ?? null)}`;
    }

    function recordCompletedToolUse(toolUse) {
      if (!toolUse?.tool) return;
      const normalized = {
        id: typeof toolUse.id === "string" && toolUse.id.trim() ? toolUse.id.trim() : null,
        tool: toolUse.tool,
        input: toolUse.input && typeof toolUse.input === "object" ? toolUse.input : null,
      };
      const key = toolUseReplayKey(normalized);
      if (seenToolUseKeys.has(key)) return;
      seenToolUseKeys.add(key);
      toolUses.push(normalized);

      if (onLine && normalized.tool) {
        // Strip MCP server prefixes so the live log shows the bare tool
        // name (e.g. "chain_read" instead of "mcp__posse-gateway__chain_read").
        const gatewayDisplayName = normalized.tool
          .replace(/^mcp__atlas-v2__/, "atlas.");
        let displayName = stripPosseMcpGatewayPrefix(gatewayDisplayName)
          .replace(/^mcp__atlas-v2__/, "atlas.");
        // The chain_read / chain_verdict pair gates a single file review.
        // chain_verdict's args never carry the file path (that lives in
        // the MCP server's chain state), so thread the path forward from
        // the most recent chain_read for a cleaner live log.
        let enrichedInput = normalized.input || {};
        if (displayName === "chain_read" && enrichedInput.path) {
          _lastChainReadPath = enrichedInput.path;
        } else if (displayName === "chain_verdict" && _lastChainReadPath && !enrichedInput.path) {
          enrichedInput = { ...enrichedInput, path: _lastChainReadPath };
          _lastChainReadPath = null; // consumed
        }
        displayName = formatAtlasToolUseDisplayName(normalized.tool, enrichedInput) || displayName;
        const target = summarizeObservedToolUse(normalized.tool, enrichedInput).target;
        if (target) {
          // Shorten absolute paths to relative when they start with cwd.
          try {
            const cwdNorm = providerPaths.cwd.replace(/\\/g, "/");
            const targetNorm = target.replace(/\\/g, "/");
            const short = targetNorm.startsWith(cwdNorm + "/")
              ? targetNorm.slice(cwdNorm.length + 1)
              : targetNorm;
            if (shouldShowPreResultToolTarget(displayName, short)) {
              onLine(`${C.dim}[tool] ${displayName}: ${short}${C.reset}`);
            } else {
              onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
            }
          } catch (_e) {
            if (shouldShowPreResultToolTarget(displayName, target)) {
              onLine(`${C.dim}[tool] ${displayName}: ${target}${C.reset}`);
            } else {
              onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
            }
          }
        } else {
          // No target (e.g. chain_verdict with only a verdict field) —
          // still log the tool name so the live stream shows activity.
          onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
        }
      }
    }

    const spinFrames = ["|", "/", "-", "\\"];
    let spinIdx = 0;
    let lastActivity = Date.now();

    let heartbeat;
    if (directOutput) {
      heartbeat = setInterval(() => {
        if (!gotFirstOutput) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const frame = spinFrames[spinIdx++ % spinFrames.length];
          process.stdout.write(`\r${color}|${C.reset} ${C.dim}${frame} waiting... ${elapsed}s${C.reset}   `);
        }

        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          const phase = gotFirstOutput ? "mid-execution" : "waiting for first output";
          process.stdout.write(`\r${color}|${C.reset} ${C.red}!! Stalled ${phase} (no output for ${(STALL_TIMEOUT / 1000)}s) -- killing process.${C.reset}\n`);
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    } else if (onLine) {
      heartbeat = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          const phase = gotFirstOutput ? "mid-execution" : "waiting for first output";
          onLine(`${C.red}!! Stalled ${phase} (no output for ${(STALL_TIMEOUT / 1000)}s) -- killing process${C.reset}`);
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    } else {
      // Silent mode (no display, no direct output) — still need stall detection
      // or the process can hang forever with no way to recover.
      heartbeat = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    }

    /** Emit accumulated text lines to onLine/directOutput. */
    function emitTextLines(text) {
      textLineBuf += text;
      const lines = textLineBuf.split("\n");
      textLineBuf = lines.pop(); // keep incomplete last line
      if (textLineBuf.length > LINE_BUF_MAX) {
        textLineBuf = textLineBuf.slice(-LINE_BUF_MAX);
      }
      for (const ln of lines) {
        if (directOutput) {
          process.stdout.write(`${color}|${C.reset} ${ln}\n`);
        } else if (onLine) {
          onLine(ln);
        }
        lineCount++;
      }
    }

    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");

    proc.stdout.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        rawStdout += text;
        lastActivity = Date.now();

        // Parse stream-json JSONL — each complete line is a JSON message
        jsonLineBuf += text;
        const jsonLines = jsonLineBuf.split("\n");
        jsonLineBuf = jsonLines.pop(); // keep incomplete last line
        if (jsonLineBuf.length > LINE_BUF_MAX) {
          if (onLine) onLine(`${C.yellow}stream-json line exceeded ${LINE_BUF_MAX} bytes without newline — dropping buffer${C.reset}`);
          jsonLineBuf = "";
        }

        for (const raw of jsonLines) {
          if (!raw.trim()) continue;
          try {
            const msg = JSON.parse(raw);
            latestSessionHandle = __testExtractClaudeSessionHandleFromStreamMessage(msg) || latestSessionHandle;

          // Text content deltas — stream to display.
          // Accept any delta that carries text (text_delta, input_json_delta, etc.)
          // to avoid silently dropping output if the CLI changes delta types.
          const deltaText = msg.type === "content_block_delta" && msg.delta?.text;
          if (deltaText) {
            if (!gotFirstOutput) {
              gotFirstOutput = true;
              const waitTime = ((Date.now() - startTime) / 1000).toFixed(1);
              if (directOutput) {
                process.stdout.write(`\r${color}|${C.reset} ${C.dim}first output after ${waitTime}s${C.reset}                    \n`);
              } else if (onLine) {
                onLine(`${C.dim}first output after ${waitTime}s${C.reset}`);
              }
            }
            fullOutput += deltaText;
            emitTextLines(deltaText);
          }

          // Track tool use — capture tool name on block start, accumulate
          // input JSON from deltas, finalize on block stop.
          if (msg.type === "content_block_start" && msg.content_block?.type === "tool_use") {
            _pendingToolUse = {
              id: typeof msg.content_block.id === "string" ? msg.content_block.id : null,
              tool: msg.content_block.name,
              input: null,
            };
            _pendingToolInput = "";
          }
          if (_pendingToolUse && msg.type === "content_block_delta" && msg.delta?.type === "input_json_delta") {
            _pendingToolInput += msg.delta.partial_json || "";
          }
          if (msg.type === "content_block_stop" && _pendingToolUse) {
            try { _pendingToolUse.input = JSON.parse(_pendingToolInput); } catch { /* partial */ }
            recordCompletedToolUse(_pendingToolUse);
            _pendingToolUse = null;
            _pendingToolInput = "";
          }

          // Newer Claude Code stream-json sessions may emit complete
          // assistant messages with content[] tool_use blocks instead of
          // Anthropic-style content_block_start/content_block_delta events.
          for (const toolUse of _extractClaudeToolUsesFromStreamMessage(msg)) {
            recordCompletedToolUse(toolUse);
          }

          // Final result — contains usage stats and possibly full output
          if (msg.type === "result") {
            resultData = msg;
            // Only use result.result if it's more complete than what we accumulated
            // from content_block_delta events. This avoids wiping good output with
            // a truncated or final-turn-only result string.
            if (msg.result && typeof msg.result === "string" && msg.result.length > fullOutput.length) {
              fullOutput = msg.result;
            }
          }
          } catch {
            // Not valid JSON — may be a raw line during fallback, emit as text
            if (!gotFirstOutput) {
              gotFirstOutput = true;
            }
            if (directOutput) {
              process.stdout.write(`${color}|${C.reset} ${raw}\n`);
            } else if (onLine && raw.trim()) {
              onLine(raw);
            }
            fullOutput += raw + "\n";
            lineCount++;
          }
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        if (directOutput) process.stderr.write(`${color}|${C.reset} ${C.yellow}[stderr] ${msg}${C.reset}\n`);
        else if (onLine) onLine(`${C.yellow}[stderr] ${msg}${C.reset}`);
      }
    });

    proc.stderr.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stderr += text;
        lastActivity = Date.now();
        if (directOutput && text.trim()) {
          process.stderr.write(`${color}|${C.reset} ${C.dim}${C.yellow}[stderr] ${text.trim()}${C.reset}\n`);
        } else if (onLine && text.trim()) {
          onLine(`${C.yellow}[stderr] ${text.trim()}${C.reset}`);
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stderr handler error");
        if (directOutput) process.stderr.write(`${color}|${C.reset} ${C.yellow}[stderr] ${msg}${C.reset}\n`);
        else if (onLine) onLine(`${C.yellow}[stderr] ${msg}${C.reset}`);
      }
    });

    proc.on("close", (code, signal) => {
      cleanupSetupFiles();
      if (heartbeat) clearInterval(heartbeat);
      clearForceKillTimers();
      const durationMs = Date.now() - startTime;
      const elapsed = (durationMs / 1000).toFixed(1);

      // Bug fix: flush remaining jsonLineBuf — if the final result message
      // arrived without a trailing newline, it's stuck here unparsed.
      if (jsonLineBuf.trim()) {
        try {
          const msg = JSON.parse(jsonLineBuf);
          latestSessionHandle = __testExtractClaudeSessionHandleFromStreamMessage(msg) || latestSessionHandle;
          if (msg.type === "content_block_delta" && msg.delta?.text) {
            fullOutput += msg.delta.text;
            emitTextLines(msg.delta.text);
          }
          if (msg.type === "content_block_start" && msg.content_block?.type === "tool_use") {
            _pendingToolUse = {
              id: typeof msg.content_block.id === "string" ? msg.content_block.id : null,
              tool: msg.content_block.name,
              input: null,
            };
            _pendingToolInput = "";
          }
          if (_pendingToolUse && msg.type === "content_block_delta" && msg.delta?.type === "input_json_delta") {
            _pendingToolInput += msg.delta.partial_json || "";
          }
          if (msg.type === "content_block_stop" && _pendingToolUse) {
            try { _pendingToolUse.input = JSON.parse(_pendingToolInput); } catch { /* partial */ }
            recordCompletedToolUse(_pendingToolUse);
            _pendingToolUse = null;
            _pendingToolInput = "";
          }
          for (const toolUse of _extractClaudeToolUsesFromStreamMessage(msg)) {
            recordCompletedToolUse(toolUse);
          }
          if (msg.type === "result") {
            resultData = msg;
          }
        } catch {
          // Not valid JSON — treat as raw text
          fullOutput += jsonLineBuf + "\n";
        }
        jsonLineBuf = "";
      }

      // Flush any remaining text in the line buffer
      if (textLineBuf.trim()) {
        if (directOutput) {
          process.stdout.write(`${color}|${C.reset} ${textLineBuf}\n`);
        } else if (onLine) {
          onLine(textLineBuf);
        }
        lineCount++;
      }

      if (directOutput) {
        // footer intentionally suppressed — elapsed time is logged via onLine/event system
      } else if (onLine) {
        // Show output chars when lineCount is 0 but we have output (common with
        // stream-json where output arrives via the result message, not deltas).
        const sizeHint = lineCount === 0 && fullOutput.length > 0
          ? ` (${fullOutput.length} chars via result)`
          : "";
        onLine(`${C.dim}completed: ${elapsed}s | ${lineCount} lines${sizeHint}${C.reset}`);
      }

      // Extract token usage from stream-json result, fallback to stderr parsing
      const usage = _extractStreamUsage(resultData);
      const stderrTokens = parseTokenUsage(stderr);
      const normalizedUsage = normalizeProviderUsage("claude", usage, { stderrTokens });
      const apiEquivalentCostUsd = _estimateClaudeApiEquivalentCostUsd({
        modelName: modelToUse,
        modelTier,
        usage,
        stderrTokens,
      });
      latestSessionHandle = __testExtractClaudeSessionHandleFromStreamMessage(resultData) || latestSessionHandle;

      const stats = {
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        promptChars: finalPrompt.length,
        outputChars: fullOutput.length,
        inputTokens: normalizedUsage.inputTokens,
        outputTokens: normalizedUsage.outputTokens,
        cacheCreationInputTokens: normalizedUsage.cacheCreationInputTokens,
        cacheReadInputTokens: normalizedUsage.cacheReadInputTokens,
        cachedInputTokens: normalizedUsage.cachedInputTokens,
        reasoningOutputTokens: normalizedUsage.reasoningOutputTokens,
        costUsd: apiEquivalentCostUsd ?? resultData?.cost_usd ?? null,
        totalCostUsd: resultData?.total_cost_usd || null,
        numTurns: resultData?.num_turns || null,
        durationMs,
        exitCode: code,
        maxTurns: turns,
        toolUses: toolUses.length > 0 ? toolUses : null,
        atlasMethod: atlasMethodForStats,
        sessionHandle: latestSessionHandle || null,
        priorSessionHandle: priorSessionHandle || null,
        sessionExpired: false,
        executionMode: CLAUDE_EXECUTION_MODE_PRINT,
      };

      // Persist MCP-relevant CLI stderr (only when present) so a gateway
      // attach-under-load failure leaves a trace even on a clean exit, where
      // the stderr would otherwise be discarded. Best-effort; never throws.
      try {
        logProviderCliStderrTelemetry({
          providerName: "claude",
          role,
          workItemId,
          jobId,
          attemptId,
          exitCode: code,
          stderr,
        });
      } catch { /* telemetry only */ }

      if (code !== 0) {
        const reason = killedByStallDetector ? "stall_kill" : "error";
        const exhaustedTurns = !killedByStallDetector
          && !fullOutput.trim()
          && resultData?.num_turns != null
          && turns != null
          && Number(resultData.num_turns) >= Number(turns);
        const prefix = killedByStallDetector
          ? `claude killed by stall detector (no output for ${baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1)}s)`
          : exhaustedTurns
            ? `claude exhausted turn budget (${resultData?.num_turns}/${turns})`
            : Number.isFinite(code)
              ? `claude exited ${code}`
              : signal
                ? `claude exited via signal ${signal}`
                : "claude exited with unknown status";
        // Build a tool-use summary so retries know what was already explored
        let toolSummary = "";
        if (toolUses.length > 0) {
          const lines = toolUses.map((toolUse) => summarizeObservedToolUse(toolUse.tool, toolUse.input || {}).summary);
          toolSummary = `\nTool calls (${toolUses.length}): ${lines.join("; ")}`;
        }
        const err = new Error(`${prefix}${stderr ? '\n' + stderr : ''}${fullOutput ? '\nPartial output: ' + fullOutput.slice(0, 500) : ''}${toolSummary}`);
        err.code = code;
        err.stats = stats;
        err.stallKill = killedByStallDetector;
        err.stderr = stderr || null;
        err.stdout = fullOutput || null;
        err.partialOutput = fullOutput || null;
        err.toolUses = toolUses.length > 0 ? toolUses : null;
        err.sessionExpired = !!priorSessionHandle && isClaudeResumeHandleExpiredError(`${stderr}\n${fullOutput}\n${prefix}`);
        if (err.sessionExpired) err.stats.sessionExpired = true;
        reject(err);
      } else {
        // Detect empty output — likely the model exhausted its turn budget on
        // tool calls and never produced a final text response.
        if (!fullOutput.trim() && turns) {
          const usedTurns = resultData?.num_turns || "?";
          if (onLine) {
            onLine(`${C.yellow}⚠ empty output after ${usedTurns}/${turns} turns (${elapsed}s) — model may have exhausted turn budget on tool calls${C.reset}`);
          }
        }
        resolve({ output: fullOutput.trim(), stats });
      }
    });

    proc.on("error", (err) => {
      cleanupSetupFiles();
      if (heartbeat) clearInterval(heartbeat);
      clearForceKillTimers();
      const wrapped = new Error(
        `Failed to spawn claude at: ${CLAUDE_CMD} ${CLAUDE_ARGS.join(" ")}\n` +
        `Is Claude Code installed? npm install -g @anthropic-ai/claude-code\n${err.message}`
      );
      wrapped.stats = {
        role,
        modelTier,
        modelName: modelToUse,
        promptChars: finalPrompt.length,
        outputChars: 0,
        durationMs: Date.now() - startTime,
        exitCode: null,
        maxTurns: turns,
        executionMode: CLAUDE_EXECUTION_MODE_PRINT,
      };
      reject(wrapped);
    });
    } catch (err) {
      cleanupSetupFiles();
      reject(err);
    }
    })();
  });
}


// ─── JSON Extraction ────────────────────────────────────────────────────────

// Sanitize common LLM JSON quirks that JSON.parse rejects:
//   - trailing commas:  [1, 2,]  or  {"a": 1,}
//   - single-line comments:  // ...
//   - block comments:  /* ... */
// ─── User Input ─────────────────────────────────────────────────────────────

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let resolved = false;
    rl.question(question, (answer) => {
      resolved = true;
      rl.close();
      resolve(answer.trim());
    });
    // Handle EOF (piped input, non-interactive terminal)
    rl.on("close", () => {
      if (!resolved) resolve("");
    });
  });
}

export function askMultiline(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(prompt);
    console.log(`  ${C.dim}(enter a blank line when done)${C.reset}`);
    const lines = [];
    let resolved = false;
    rl.on("line", (line) => {
      if (line.trim() === "" && lines.length > 0) {
        resolved = true;
        rl.close();
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    });
    // Handle EOF (piped input, non-interactive terminal) — resolve with whatever we have
    rl.on("close", () => {
      if (!resolved) resolve(lines.join("\n"));
    });
  });
}

// ─── Model Escalation ───────────────────────────────────────────────────────

/**
 * Given a current model_tier and attempt count, return the escalated tier.
 * Attempt 1: same tier. Attempt 2: tier+1. Attempt 3+: strong.
 */
export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

// ─── Rate Limit State ──────────────────────────────────────────────────────
// Global, shared across all workers in the same process. When one worker hits
// a rate limit, all others see it immediately and back off.

/**
 * Trip the global rate limit. All workers will see this and back off.
 * @param {number} backoffSec - How long to block (from now).
 * @param {string} reason - Human-readable reason for logging.
 */
export function tripRateLimit(backoffSec, reason = "") {
  providerRuntimeState.tripRateLimit("claude", backoffSec, reason);
}

/**
 * Check if the Claude provider is currently rate-limited.
 * @returns {{ blocked: boolean, retryInSec: number, reason: string }}
 */
export function getRateLimitState() {
  return providerRuntimeState.getRateLimitState("claude");
}

/**
 * Parse a provider error and return the recommended backoff.
 * Extracts real retry-after from error messages when available.
 *
 * Claude CLI error patterns:
 *   "overloaded_error"          → server busy, short wait (10s)
 *   "rate_limit_error"          → RPM/TPM limit, longer wait (30s)
 *   "Please retry after Xs"     → explicit retry-after
 *   "429"                       → HTTP rate limit (30s)
 *   "API Error: 529"            → overloaded (15s)
 *   "API Error: 5xx"            → server error (10s)
 *   "ECONNREFUSED/RESET/TIMEOUT"→ connection issue (5s)
 *
 * @param {Error} err
 * @returns {{ backoffSec: number, isRateLimit: boolean, source: string }}
 */
export function parseErrorBackoff(err) {
  const failure = classifyClaudeCliFailure(err);
  if (failure?.classification === "invalid_client") {
    return { backoffSec: 0, isRateLimit: false, source: "invalid_client" };
  }

  return classifyProviderError(err, { defaultBackoffSec: 15 });
}
