import fs from "fs";
import path from "path";
import { getSetting } from "../../../queue/functions/index.js";
import { assertTestContext } from "../../../runtime/functions/test-context.js";
import { ClaudeCliNotFoundError } from "../../classes/claude/ClaudeCliNotFoundError.js";
import { buildWindowsSpawn } from "../shared/windows-spawn.js";
import { discoverCommandCandidates } from "../shared/cli-discovery.js";

let claudeCommand;
let claudeArgs;
const CLAUDE_CLI_PATH_SETTING = "claude_cli_path";
const WINDOWS_SPAWNABLE_CLAUDE_EXTS = new Set([".exe", ".cmd", ".bat", ".com"]);

function resolvedCommandSnapshot() {
  return {
    command: claudeCommand,
    args: Array.isArray(claudeArgs) ? [...claudeArgs] : [],
  };
}

export function selectWindowsClaudeBinary(lines) {
  const candidates = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const spawnable = candidates.find((candidate) =>
    WINDOWS_SPAWNABLE_CLAUDE_EXTS.has(path.extname(candidate).toLowerCase())
  );
  return spawnable || candidates[0];
}

function readClaudeCliPathSetting() {
  try {
    const value = getSetting(CLAUDE_CLI_PATH_SETTING);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

// Parse an npm-style `claude.cmd` wrapper and return the JS entry point it
// launches, allowing Posse to spawn `node <entry>` instead of the wrapper.
export function extractCmdShimJsPath(cmdContent, binPath) {
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

function configureClaudeCommandFromBinary(binPath) {
  const isWin = process.platform === "win32";
  if (isWin && binPath.toLowerCase().endsWith(".cmd")) {
    try {
      const cmdContent = fs.readFileSync(binPath, "utf-8");
      const jsPath = extractCmdShimJsPath(cmdContent, binPath);
      if (jsPath && fs.existsSync(jsPath)) {
        claudeCommand = process.execPath;
        claudeArgs = [jsPath];
        return;
      }
    } catch {
      // Fall back to invoking the wrapper directly.
    }

    claudeCommand = binPath;
    claudeArgs = [];
    return;
  }

  claudeCommand = binPath;
  claudeArgs = [];
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

export function ensureClaudeResolved() {
  if (!claudeCommand) resolveClaude();
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
        claudeCommand = process.execPath;
        claudeArgs = [jsPath];
        return;
      }
    } catch {
      // Fall back to invoking the wrapper directly.
    }
    claudeCommand = binPath;
    claudeArgs = [];
    return;
  }
  claudeCommand = binPath;
  claudeArgs = [];
}

export async function ensureClaudeResolvedAsync() {
  if (!claudeCommand) await resolveClaudeAsync();
}

export function getClaudeCommand() {
  ensureClaudeResolved();
  return resolvedCommandSnapshot();
}

export async function getClaudeCommandAsync() {
  await ensureClaudeResolvedAsync();
  return resolvedCommandSnapshot();
}

export function getClaudeReadiness() {
  try {
    const { command, args } = getClaudeCommand();
    return { ready: true, reason: null, cmd: command, args };
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
  const { command, args } = getClaudeCommand();
  return { cmd: command, args };
}

export function __testSelectWindowsClaudeBinary(lines) {
  return selectWindowsClaudeBinary(lines);
}

export function __testBuildClaudeSpawn(command, args = []) {
  return buildWindowsSpawn(command, args);
}

export function __testExtractCmdShimJsPath(cmdContent, binPath) {
  return extractCmdShimJsPath(cmdContent, binPath);
}

export function __testResetClaudeResolution() {
  assertTestContext("__testResetClaudeResolution");
  claudeCommand = undefined;
  claudeArgs = undefined;
}

export function __testSetClaudeResolution(command, args = []) {
  assertTestContext("__testSetClaudeResolution");
  claudeCommand = command || undefined;
  claudeArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}
