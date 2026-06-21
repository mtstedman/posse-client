// lib/domains/providers/functions/copilot.js
//
// GitHub Copilot CLI provider for the posse orchestrator.
//
// PHASE 1 (this file): SKELETON ONLY.
//   - Registers the provider in the catalog/registry surface.
//   - Implements credentials/readiness checks so `posse status` / settings
//     surfaces show the right state ("binary missing", "no token", etc.).
//   - callProvider() throws "not_implemented" until Phase 2 lands.
//
// PHASE 2 (next): implement the spawn/JSONL pipeline modeled on
//   `lib/domains/providers/functions/codex.js`. The shape mirrors `codex exec` —
//   spawn `copilot -p <prompt> --output-format json --model <tier>` and
//   consume the JSONL stream line-by-line.
//
// PHASE 3: ATLAS v2 MCP attachment via `--additional-mcp-config <path>`.
//
// Auth model: dual — OAuth state managed by the copilot CLI itself, or
// a fine-grained PAT in the environment. Resolution order:
//   1. OAuth — `~/.copilot/config.json` lists at least one logged-in
//      user. The CLI handles token refresh and request signing on its
//      own; posse just spawns and lets it talk to GitHub.
//   2. PAT — `GH_TOKEN`, then `GITHUB_TOKEN`. Used as a fallback for CI
//      environments where the operator can't run `copilot login`
//      interactively. Token needs the "Copilot Requests" fine-grained
//      permission.
// Interactive `copilot login` should be done OUT of band, not by Posse.
// We never invoke the device-flow ourselves.
//
// Pricing model: subscription quota (premium requests × per-model
// multiplier), NOT per-token. Cost-tier routing is documented as a
// Phase 5 follow-up; until then, expect the rate-limiter to trip when
// the daily/monthly quota is exhausted and the delegator to fall
// through to the next provider in the provider_<role> account setting.

import { execFileSync, spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getSetting } from "../../queue/functions/index.js";
import { buildRuntimeEnv } from "../../runtime/functions/paths.js";
import { appendBoundedText } from "../../../shared/format/functions/bounded-text.js";
import {
  C,
  ask,
  askMultiline,
  extractJson,
  resolveDisableSystemTools,
  resolveWebToolsEnabled,
} from "./claude.js";
import { getProviderTierDefaults } from "./model-catalog.js";
import { classifyProviderError } from "./helpers/api-resilience.js";
import { resolveProviderStallTimeout } from "./helpers/stall-timeout.js";
import { escalateModelTier, getMaxTurnsForProvider } from "./helpers/turns.js";
import { selectExecutionModel } from "./helpers/model-selection.js";
import {
  consumeCopilotLine,
  createAccumulator,
  finalOutput as copilotFinalOutput,
} from "./helpers/copilot-events.js";

export { C, ask, askMultiline, extractJson, resolveDisableSystemTools, resolveWebToolsEnabled };

export const capabilities = Object.freeze({ images: false, sessionResume: false, toolAttachment: "mcp" });

const LINE_BUF_MAX = 16 * 1024 * 1024;

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("copilot").cheap.model,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("copilot").standard.model,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("copilot").strong.model,
    label: "STRONG",
    color: "magenta",
  },
};

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** @type {string | null} */
let COPILOT_CMD = null;
/** @type {string | null} */
let COPILOT_RESOLVE_ERROR = null;
let _copilotResolved = false;

// Copilot's `--version` actually loads the npm-installed CLI to print
// the build string, so cold-start can take 10-20s on Windows where the
// `.cmd` shim chains through node + the package's main. We give it a
// generous timeout because hitting it is a one-time per-process cost.
const COPILOT_PROBE_TIMEOUT_MS = 30_000;

function probeCopilotVersion(cmd) {
  try {
    const launch = buildCopilotSpawn(cmd, ["--version"]);
    const result = spawnSync(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COPILOT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    return result?.status === 0;
  } catch {
    return false;
  }
}

function resolveCopilot() {
  const configured = readModelSetting("copilot_cli_path");
  if (configured && fs.existsSync(configured) && probeCopilotVersion(configured)) {
    COPILOT_RESOLVE_ERROR = null;
    COPILOT_CMD = configured;
    return;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const raw = execFileSync(locator, ["copilot"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw) {
      const lines = raw.split(/\r?\n/).filter(Boolean);
      // Windows `where` returns multiple lines; prefer an unambiguous
      // shim with an .exe / .cmd suffix over the bare path.
      const preferred = lines.find((line) => /\.(exe|cmd)$/i.test(line)) || lines[0];
      if (preferred && probeCopilotVersion(preferred)) {
        COPILOT_RESOLVE_ERROR = null;
        COPILOT_CMD = preferred;
        return;
      }
    }
  } catch {
    // Fall through.
  }

  // Last-ditch: rely on PATH lookup via shell. spawnSync with shell:true
  // on Windows resolves the bare command against PATH and finds the
  // .cmd shim. This is the slow path; prior branches should have hit.
  if (probeCopilotVersion("copilot")) {
    COPILOT_RESOLVE_ERROR = null;
    COPILOT_CMD = "copilot";
    return;
  }

  COPILOT_RESOLVE_ERROR = "Copilot CLI not found on PATH (install via `winget install GitHub.CopilotCLI` or `npm i -g @github/copilot-cli`).";
  COPILOT_CMD = null;
}

function ensureCopilotResolved() {
  if (_copilotResolved && COPILOT_CMD) return;
  _copilotResolved = true;
  resolveCopilot();
}

// Exposed for tests + observability.
export function getCopilotInfo() {
  ensureCopilotResolved();
  return { cmd: COPILOT_CMD, error: COPILOT_RESOLVE_ERROR };
}

// ---------------------------------------------------------------------------
// Settings + model selection
// ---------------------------------------------------------------------------

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function getModelOverride() {
  return readModelSetting("copilot_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`copilot_model_${key}`) || base.model,
  };
}

function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider("copilot", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

// Standard escalation ladder: a failed `cheap` attempt is retried at
// `standard`, a failed `standard` at `strong`. Mirrors codex/claude.
// Accepts a `resolveModel(tier)` option so escalation can skip past
// tiers whose configured model matches the input (see escalateModelTier).
export function escalateTier(currentTier, attemptCount = 1, options = {}) {
  const tier = String(currentTier || "standard").toLowerCase();
  return escalateModelTier(tier, attemptCount, options);
}

// ---------------------------------------------------------------------------
// Auth + readiness
// ---------------------------------------------------------------------------

/**
 * Look for a stashed PAT in the environment.
 * @returns {{ token: string, source: string } | null}
 */
function readCopilotToken() {
  const gh = process.env.GH_TOKEN;
  if (typeof gh === "string" && gh.trim()) return { token: gh.trim(), source: "GH_TOKEN" };
  const github = process.env.GITHUB_TOKEN;
  if (typeof github === "string" && github.trim()) return { token: github.trim(), source: "GITHUB_TOKEN" };
  return null;
}

/**
 * Check whether `copilot login` has been run interactively and a
 * logged-in user is recorded in ~/.copilot/config.json. The CLI owns
 * the token lifecycle when this is set — posse doesn't need a PAT.
 *
 * @returns {{ login: string, host: string } | null}
 */
function readCopilotOauthLogin() {
  try {
    const cfgPath = path.join(os.homedir(), ".copilot", "config.json");
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, "utf-8");
    // The config file uses JSONC-style comments; strip them before parse.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped);
    const users = Array.isArray(parsed?.loggedInUsers) ? parsed.loggedInUsers : [];
    const first = users.find((u) => u && typeof u.login === "string" && u.login.trim());
    if (!first) return null;
    return { login: String(first.login), host: String(first.host || "https://github.com") };
  } catch {
    return null;
  }
}

/**
 * @returns {{ mode: "oauth" | "pat", source: string } | null}
 */
function resolveCopilotAuth() {
  const oauth = readCopilotOauthLogin();
  if (oauth) return { mode: "oauth", source: `~/.copilot (login=${oauth.login})` };
  const pat = readCopilotToken();
  if (pat) return { mode: "pat", source: pat.source };
  return null;
}

export function hasCredentials() {
  return resolveCopilotAuth() !== null;
}

export function isReady() {
  ensureCopilotResolved();
  if (!COPILOT_CMD) return { ready: false, reason: COPILOT_RESOLVE_ERROR || "Copilot CLI not found on PATH" };
  const auth = resolveCopilotAuth();
  if (!auth) {
    return {
      ready: false,
      reason: "Copilot CLI is installed but no credential is set. Run `copilot login` interactively (preferred), or export GH_TOKEN/GITHUB_TOKEN with the \"Copilot Requests\" fine-grained permission.",
    };
  }
  return { ready: true, reason: null };
}

// Exposed for tests + observability surfaces that want to display the
// auth method without re-running the lookup.
export function getAuthMethod() {
  return resolveCopilotAuth();
}

// ---------------------------------------------------------------------------
// Rate-limit state (placeholder)
// ---------------------------------------------------------------------------
//
// Phase 5 wires quota-aware routing: when Copilot returns "quota
// exhausted" we trip this and the delegator falls through to the next
// provider. For now it stays open and any error from the provider just
// classifies through parseErrorBackoff().

let _rateLimitedUntil = 0;
let _rateLimitReason = "";

export function getRateLimitState() {
  const nowMs = Date.now();
  if (_rateLimitedUntil > nowMs) {
    return {
      blocked: true,
      retryInSec: Math.ceil((_rateLimitedUntil - nowMs) / 1000),
      reason: _rateLimitReason,
    };
  }
  return { blocked: false, retryInSec: 0, reason: "" };
}

export function tripRateLimit(backoffSec = 60, reason = "") {
  _rateLimitedUntil = Date.now() + Math.max(0, Number(backoffSec) || 0) * 1000;
  _rateLimitReason = reason || "Copilot rate limited";
}

export function parseErrorBackoff(err) {
  return classifyProviderError(err, { defaultBackoffSec: 30 });
}

// ---------------------------------------------------------------------------
// Reasoning-effort mapping
// ---------------------------------------------------------------------------
//
// Posse's role budget speaks "low" | "medium" | "high"; Copilot CLI's
// `--reasoning-effort` accepts "none" | "low" | "medium" | "high" |
// "xhigh" | "max". Pass-through when the Posse value lines up; map
// anything else to medium.

const REASONING_EFFORT_VALUES = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function normalizeReasoningEffort(value) {
  const v = String(value || "").trim().toLowerCase();
  if (REASONING_EFFORT_VALUES.has(v)) return v;
  return "medium";
}

// ---------------------------------------------------------------------------
// Child process launch/env helpers
// ---------------------------------------------------------------------------

const SENSITIVE_COPILOT_CHILD_ENV_KEY_RE = /api[_-]?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|^posse_key$/i;

function buildCopilotChildEnv(baseEnv = process.env, auth = resolveCopilotAuth()) {
  const keepSensitiveKeys = new Set();
  if (auth?.mode === "pat" && auth.source) keepSensitiveKeys.add(auth.source);

  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (SENSITIVE_COPILOT_CHILD_ENV_KEY_RE.test(String(key || "")) && !keepSensitiveKeys.has(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function isBareCommand(cmd) {
  if (!cmd) return true;
  if (path.isAbsolute(cmd)) return false;
  return !String(cmd).includes("\\") && !String(cmd).includes("/");
}

function resolveWindowsCommandPath(command) {
  if (!isBareCommand(command)) return String(command || "");
  try {
    const raw = execFileSync("where", [String(command || "")], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /\.exe$/i.test(line))
      || lines.find((line) => /\.cmd$/i.test(line))
      || lines[0]
      || String(command || "");
  } catch {
    return String(command || "");
  }
}

function resolveWindowsNpmShimLaunch(command) {
  const resolved = resolveWindowsCommandPath(command);
  if (!resolved) return null;

  const candidates = [resolved];
  if (!path.extname(resolved)) candidates.push(`${resolved}.cmd`, `${resolved}.ps1`);
  for (const candidate of candidates) {
    const basedir = path.dirname(candidate);
    const loader = path.join(basedir, "node_modules", "@github", "copilot", "npm-loader.js");
    if (!fs.existsSync(loader)) continue;
    const localNode = path.join(basedir, "node.exe");
    return {
      command: fs.existsSync(localNode) ? localNode : "node",
      argsPrefix: [loader],
    };
  }
  return null;
}

function buildCopilotSpawn(command, args, platform = process.platform) {
  const argv = Array.isArray(args) ? args : [];
  const cmd = String(command || "");
  if (platform !== "win32") {
    return { command: cmd, args: argv, windowsVerbatimArguments: false };
  }

  const resolved = resolveWindowsCommandPath(cmd);
  if (/\.exe$/i.test(resolved)) {
    return { command: resolved, args: argv, windowsVerbatimArguments: false };
  }

  const shim = resolveWindowsNpmShimLaunch(resolved);
  if (shim) {
    return {
      command: shim.command,
      args: [...shim.argsPrefix, ...argv],
      windowsVerbatimArguments: false,
    };
  }

  return { command: resolved || cmd, args: argv, windowsVerbatimArguments: false };
}

// ---------------------------------------------------------------------------
// Spawn arg builder — pure function, testable in isolation
// ---------------------------------------------------------------------------

/**
 * Build the argv list for `copilot -p ...`. The function is pure and
 * has no side effects; the spawn step lives in `callProvider`. The
 * intent is: every flag we pass to copilot should be visible here for
 * audit / tests.
 *
 * @param {{
 *   prompt: string,
 *   model: string | null,
 *   reasoningEffort: string,
 *   workingDir: string,
 *   additionalMcpConfig?: string | null,    // JSON string or @path
 *   disableBuiltinMcps?: boolean,           // suppress github-mcp-server
 *   allowAllTools?: boolean,                // required for non-interactive
 *   allowAllPaths?: boolean,
 *   noAskUser?: boolean,
 *   noColor?: boolean,
 *   stream?: "on" | "off",
 * }} args
 * @returns {string[]}
 */
export function buildCopilotArgs({
  prompt,
  model,
  reasoningEffort,
  workingDir,
  additionalMcpConfig = null,
  disableBuiltinMcps = false,
  allowAllTools = true,
  allowAllPaths = true,
  noAskUser = true,
  noColor = true,
  stream = "on",
} = {}) {
  if (typeof prompt !== "string" || !prompt) {
    throw new TypeError("buildCopilotArgs: prompt must be a non-empty string");
  }
  if (!workingDir) {
    throw new TypeError("buildCopilotArgs: workingDir is required");
  }
  const argv = [
    "-p", prompt,
    "--output-format", "json",
    "-C", workingDir,
  ];
  if (model) argv.push("--model", model);
  if (reasoningEffort) argv.push("--reasoning-effort", normalizeReasoningEffort(reasoningEffort));
  if (allowAllTools) argv.push("--allow-all-tools");
  if (allowAllPaths) argv.push("--allow-all-paths");
  if (noAskUser) argv.push("--no-ask-user");
  if (noColor) argv.push("--no-color");
  if (stream === "on" || stream === "off") argv.push("--stream", stream);
  if (disableBuiltinMcps) argv.push("--disable-builtin-mcps");
  if (additionalMcpConfig) argv.push("--additional-mcp-config", additionalMcpConfig);
  return argv;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Inspect stdout/stderr at end-of-stream to classify why a non-zero
 * exit happened. Used by callProvider to attach a stable `code` to the
 * rejection Error.
 *
 * @param {{ stdout: string, stderr: string, exit: number | null, acc: any }} args
 * @returns {{ code: string, message: string, tripRateLimit?: { backoffSec: number, reason: string } }}
 */
export function classifyCopilotFailure({ stdout = "", stderr = "", exit = 1, acc = null } = {}) {
  const combined = `${stdout}\n${stderr}`;
  if (/Access denied by policy settings/i.test(combined)) {
    return {
      code: "COPILOT_POLICY_BLOCKED",
      message: "Copilot CLI policy denies agent execution. Check https://github.com/settings/copilot or your org admin.",
      tripRateLimit: { backoffSec: 3600, reason: "policy_blocked" },
    };
  }
  if (/quota[^a-z]/i.test(combined) || /rate limit/i.test(combined) || /premium request/i.test(combined)) {
    return {
      code: "COPILOT_QUOTA_EXHAUSTED",
      message: "Copilot subscription quota exhausted or rate-limited.",
      tripRateLimit: { backoffSec: 900, reason: "quota_exhausted" },
    };
  }
  if (/unauthorized|invalid (?:token|credentials)|authentication required/i.test(combined)) {
    return {
      code: "COPILOT_AUTH_FAILED",
      message: "Copilot CLI rejected the credential. Run `copilot login` or refresh GH_TOKEN.",
      tripRateLimit: { backoffSec: 600, reason: "auth_failed" },
    };
  }
  // Walk accumulator errors as a fallback signal.
  if (acc?.errors?.length > 0) {
    const first = acc.errors[0];
    return {
      code: `COPILOT_${String(first.type || "ERROR").toUpperCase()}`,
      message: first.message || `Copilot CLI exited with code ${exit}`,
    };
  }
  return {
    code: "COPILOT_NONZERO_EXIT",
    message: `Copilot CLI exited with code ${exit}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Stats shape — mirrors codex.__testBuildCloseStats so the worker can
// consume Copilot results without per-provider branching.
// ---------------------------------------------------------------------------

function buildCopilotCloseStats({
  role,
  modelTier,
  reasoningEffort,
  modelName,
  acc,
  durationMs,
  finalOutputText,
  stdout,
  code,
  sessionHandle,
  priorSessionHandle,
}) {
  const outputBody = (finalOutputText || stdout.trim());
  return {
    role,
    modelTier,
    reasoningEffort,
    modelName,
    provider: "copilot",
    inputTokens: acc?.inputTokens || 0,
    outputTokens: acc?.outputTokens || 0,
    durationMs,
    outputChars: outputBody.length,
    exitCode: code,
    atlasMethod: "baseline",                 // Phase 3 will set this when ATLAS MCP is attached.
    toolUses: Array.isArray(acc?.toolUses) ? acc.toolUses : [],
    toolUsesLoggedByToolkit: false,
    sessionHandle: sessionHandle || null,
    priorSessionHandle: priorSessionHandle || null,
    sessionExpired: false,
  };
}

function resolveCopilotStallTimeoutMs(stallTimeout = null) {
  const ms = resolveProviderStallTimeout(stallTimeout) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// ---------------------------------------------------------------------------
// callProvider
// ---------------------------------------------------------------------------
//
// Spawn the Copilot CLI in non-interactive mode, stream JSONL events
// through the adapter, and resolve with `{ output, stats }` mirroring
// the codex contract.
//
// PHASE 2 SCOPE: spawn + JSONL pipeline + error classification. NOT
// included yet:
//   - ATLAS v2 MCP attachment (Phase 3)
//   - Scope/policy enforcement on tool surfaces (Phase 4)
//   - Quota-aware cost routing — beyond tripping the rate limit when
//     we see a quota error (Phase 5)
//
// We intentionally accept (and silently ignore) the full Codex opts
// surface so the worker call site doesn't need provider-specific
// branching. Options that have no Copilot equivalent stay no-ops.

/**
 * @param {string} promptText
 * @param {Record<string, any>} [opts]
 * @returns {Promise<{ output: string, stats: ReturnType<typeof buildCopilotCloseStats> }>}
 */
export function callProvider(promptText, opts = {}) {
  const readiness = isReady();
  if (!readiness.ready) {
    return Promise.reject(buildNotReadyError(readiness.reason));
  }

  const {
    role = "planner",
    modelTier = "standard",
    modelName = null,
    reasoningEffort = "medium",
    silent = false,
    onLine = null,
    cwd = null,
    projectDir = null,
    abortSignal = null,
    stallTimeout = null,
  } = opts || {};

  return new Promise((resolve, reject) => {
    const workingDir = String(cwd || projectDir || process.cwd());
    const tierConfig = getModelTierConfig(modelTier);
    const resolvedModel = selectExecutionModel({
      jobModelName: modelName,
      globalModelOverride: getModelOverride(),
      tierModel: tierConfig.model,
    });

    const argv = buildCopilotArgs({
      prompt: promptText,
      model: resolvedModel,
      reasoningEffort,
      workingDir,
    });

    const env = buildCopilotChildEnv(
      buildRuntimeEnv(projectDir || workingDir, workingDir, process.env),
      resolveCopilotAuth(),
    );
    // COPILOT_ALLOW_ALL is also accepted in lieu of --allow-all-tools;
    // belt-and-braces in case future versions tighten the flag set.
    env.COPILOT_ALLOW_ALL = env.COPILOT_ALLOW_ALL || "1";

    /** @type {ReturnType<typeof spawn> | null} */
    let child;
    try {
      const launch = buildCopilotSpawn(COPILOT_CMD, argv);
      child = spawn(launch.command, launch.args, {
        cwd: workingDir,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (spawnErr) {
      const err = new Error(`Failed to spawn copilot: ${spawnErr?.message || spawnErr}`);
      err.code = "COPILOT_SPAWN_FAILED";
      reject(err);
      return;
    }

    if (!child || !child.stdout || !child.stderr) {
      reject(new Error("Copilot child process did not start cleanly (no stdio handles)"));
      return;
    }

    const acc = createAccumulator();
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let killedByStall = false;
    let killedByAbort = false;
    /** @type {NodeJS.Timeout | null} */
    let stallTimer = null;
    const stallTimeoutMs = resolveCopilotStallTimeoutMs(stallTimeout);

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (stallTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          killedByStall = true;
          try { child?.kill("SIGTERM"); } catch { /* ignore */ }
        }, stallTimeoutMs);
      }
    };
    resetStallTimer();

    const onAbort = () => {
      killedByAbort = true;
      try { child?.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const handleStdoutLine = (rawLine) => {
      resetStallTimer();
      const consumed = consumeCopilotLine(rawLine, acc);
      if (!silent && typeof onLine === "function") {
        try { onLine(rawLine); } catch { /* listener should not break the stream */ }
      }
      return consumed;
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedText(stdout, chunk);
      stdoutLineBuffer += chunk;
      if (stdoutLineBuffer.length > LINE_BUF_MAX) {
        stdoutLineBuffer = "";
        resetStallTimer();
        return;
      }
      let idx;
      while ((idx = stdoutLineBuffer.indexOf("\n")) >= 0) {
        const line = stdoutLineBuffer.slice(0, idx).replace(/\r$/, "");
        stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
        if (line) handleStdoutLine(line);
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => { stderr = appendBoundedText(stderr, chunk); });

    child.on("error", (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      const wrapped = new Error(`Copilot child process error: ${err?.message || err}`);
      wrapped.code = "COPILOT_CHILD_ERROR";
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      reject(wrapped);
    });

    child.on("close", (code) => {
      if (stallTimer) clearTimeout(stallTimer);
      if (abortSignal) {
        try { abortSignal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
      // Flush any line left in the buffer.
      if (stdoutLineBuffer.trim()) {
        handleStdoutLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = "";
      }
      const durationMs = Date.now() - startTime;
      const finalText = copilotFinalOutput(acc);
      const stats = buildCopilotCloseStats({
        role,
        modelTier,
        reasoningEffort,
        modelName: resolvedModel,
        acc,
        durationMs,
        finalOutputText: finalText,
        stdout,
        code,
        sessionHandle: acc.sessionId,
        priorSessionHandle: null,
      });

      if (code === 0 && !killedByStall && !killedByAbort) {
        resolve({ output: finalText || stdout.trim(), stats });
        return;
      }

      if (killedByStall) {
        const err = new Error(`Copilot CLI stalled after ${(durationMs / 1000).toFixed(1)}s and was killed`);
        err.code = "COPILOT_STALLED";
        // The main attempt path keys on `err.stallKill` to route to the
        // penalty-free stall path + stall cap (claude/codex/openai/grok all set
        // it). Without this flag, dev/planner/researcher stalls take a full
        // attempt penalty instead. (B15)
        err.stallKill = true;
        err.stats = stats;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (killedByAbort) {
        const err = new Error("Copilot CLI run was aborted by the caller");
        err.code = "COPILOT_ABORTED";
        err.stats = stats;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      const classified = classifyCopilotFailure({ stdout, stderr, exit: code, acc });
      if (classified.tripRateLimit) {
        tripRateLimit(classified.tripRateLimit.backoffSec, classified.tripRateLimit.reason);
      }
      const err = new Error(classified.message);
      err.code = classified.code;
      err.exitCode = code;
      err.stats = stats;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function buildNotReadyError(reason) {
  const err = new Error(`Copilot provider is not ready: ${reason}`);
  err.code = "COPILOT_NOT_READY";
  return err;
}

// Exposed for tests.
export const __testClassifyCopilotFailure = classifyCopilotFailure;
export const __testBuildCopilotArgs = buildCopilotArgs;
export const __testBuildCopilotCloseStats = buildCopilotCloseStats;
export const __testBuildCopilotChildEnv = buildCopilotChildEnv;
export const __testBuildCopilotSpawn = buildCopilotSpawn;
export const __testResolveCopilotStallTimeoutMs = resolveCopilotStallTimeoutMs;
