import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const REASONING_EFFORT_VALUES = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const SENSITIVE_COPILOT_CHILD_ENV_KEY_RE = /api[_-]?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|^posse_key$/i;

function normalizeReasoningEffort(value) {
  const v = String(value || "").trim().toLowerCase();
  if (REASONING_EFFORT_VALUES.has(v)) return v;
  return "medium";
}

export function buildCopilotChildEnv(baseEnv = process.env, auth = null) {
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

export function buildCopilotSpawn(command, args, platform = process.platform) {
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

export function buildCopilotArgs({
  prompt,
  model,
  reasoningEffort,
  workingDir,
  additionalMcpConfig = null,
  disableBuiltinMcps = false,
  allowAllTools = false,
  allowAllPaths = false,
  availableTools = [],
  allowTools = [],
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
  if (Array.isArray(availableTools) && availableTools.length > 0) {
    argv.push(`--available-tools=${availableTools.map(String).filter(Boolean).join(",")}`);
  }
  for (const tool of Array.isArray(allowTools) ? allowTools : []) {
    if (tool) argv.push(`--allow-tool=${String(tool)}`);
  }
  if (noAskUser) argv.push("--no-ask-user");
  if (noColor) argv.push("--no-color");
  if (stream === "on" || stream === "off") argv.push("--stream", stream);
  if (disableBuiltinMcps) argv.push("--disable-builtin-mcps");
  if (additionalMcpConfig) argv.push("--additional-mcp-config", additionalMcpConfig);
  return argv;
}
