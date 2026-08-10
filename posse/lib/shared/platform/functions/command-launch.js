// @ts-check
//
// Cross-platform command resolution and launch specifications. Windows package
// manager shims may be native .exe files or shell-backed .cmd/.bat files; the
// latter cannot be spawned directly by Node. Keep discovery and execution on
// one contract so readiness probes cannot reject a command the runner can use.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function envValue(env, name) {
  const target = String(name || "").toUpperCase();
  for (const [key, value] of Object.entries(env || {})) {
    if (String(key).toUpperCase() === target && value != null) return String(value);
  }
  return "";
}

function quoteCmdToken(value) {
  return `"${String(value ?? "").replace(/"/gu, '""')}"`;
}

/**
 * Resolve a bare Windows command through the same PATH/PATHEXT lookup a user
 * gets from `where.exe`. The first executable candidate keeps Windows lookup
 * precedence while accepting native executables and shell-backed shims.
 *
 * @param {string} command
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncImpl?: typeof spawnSync,
 * }} [opts]
 * @returns {string}
 */
export function resolveWindowsCommand(command, {
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const raw = String(command || "");
  if (platform !== "win32" || !raw || path.win32.isAbsolute(raw) || /[\\/]/u.test(raw)) return raw;

  let result;
  try {
    result = spawnSyncImpl("where.exe", [raw.replace(/\.(?:cmd|bat)$/iu, "")], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    return raw;
  }
  if (result?.status !== 0) return raw;
  const candidates = String(result.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => /\.(?:cmd|bat|exe)$/iu.test(candidate))
    || candidates[0]
    || raw;
}

/**
 * Build the exact process invocation for a command. On Windows, .cmd/.bat
 * shims run through ComSpec while native .exe commands run directly.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncImpl?: typeof spawnSync,
 * }} [opts]
 * @returns {{ command: string, args: string[], windowsVerbatimArguments?: boolean }}
 */
export function commandSpawnSpec(command, args = [], {
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolved = resolveWindowsCommand(command, { platform, env, spawnSyncImpl });
  if (platform !== "win32") return { command: resolved, args: [...args] };

  const commandPath = path.win32;
  if (/^npm(?:\.cmd)?$/iu.test(commandPath.basename(resolved))) {
    const npmCli = commandPath.join(commandPath.dirname(resolved), "node_modules", "npm", "bin", "npm-cli.js");
    const adjacentNode = commandPath.join(commandPath.dirname(resolved), "node.exe");
    if (fileExists(npmCli) && fileExists(adjacentNode)) {
      return { command: adjacentNode, args: [npmCli, ...args] };
    }
  }

  if (/\.(?:cmd|bat)$/iu.test(resolved)) {
    const commandLine = [resolved, ...args].map(quoteCmdToken).join(" ");
    return {
      command: envValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args: [...args] };
}
