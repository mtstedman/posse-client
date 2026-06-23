// lib/domains/providers/functions/codex/cli-discovery.js

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { buildWindowsSpawn } from "../shared/windows-spawn.js";
import { discoverCommandCandidates } from "../shared/cli-discovery.js";
import { readModelSetting } from "./settings.js";
import { getConfiguredCodexAuthMode, resolveCodexAuthModeInternal } from "./auth.js";

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

export function isProtectedWindowsAppCodexPath(candidate) {
  const normalized = String(candidate || "").replace(/\//g, "\\").toLowerCase();
  return normalized.includes("\\windowsapps\\openai.codex_")
    && normalized.includes("\\app\\resources\\codex");
}

export function resolveWindowsPathCommand(commandBase, envPath = getWindowsEnvPath()) {
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

export function formatSpawnLaunchForError(launch) {
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
      child.stdout?.on("data", (chunk) => { stdout = appendBoundedText(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = appendBoundedText(stderr, chunk); });
      child.on("error", (error) => finish({ status: null, signal: null, error }));
      child.on("exit", (status, signal) => finish({ status, signal: signal || null, error: null }));
    } catch (error) {
      finish({ status: null, signal: null, error });
    }
  });
}

export function isExecutableCodexCli(exePath, spawnSyncImpl = spawnSync) {
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

export function codexCliSupportsExecContract(exePath, spawnSyncImpl = spawnSync) {
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
export function ensureCodexResolved() {
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
export async function ensureCodexResolvedAsync() {
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

export function getCodexLaunchState() {
  return { cmd: CODEX_CMD, args: CODEX_ARGS, error: CODEX_RESOLVE_ERROR };
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
