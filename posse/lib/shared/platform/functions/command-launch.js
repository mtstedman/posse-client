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

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isRunnableFile(filePath, platform) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    // Windows has no execute bit; PATHEXT decides what runs.
    if (platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file names Windows tries for a command: the name as given when it already
 * ends in a PATHEXT extension, otherwise the name with each PATHEXT extension.
 *
 * @param {string} command
 * @param {string} pathext
 * @returns {string[]}
 */
function windowsCommandNames(command, pathext) {
  const parse = (value) => [...new Set(String(value || "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith(".") && ext.length > 1))];
  const configured = parse(pathext);
  const exts = configured.length > 0 ? configured : parse(DEFAULT_WINDOWS_PATHEXT);
  if (exts.includes(path.win32.extname(command).toLowerCase())) return [command];
  return exts.map((ext) => `${command}${ext}`);
}

/**
 * @param {string} command
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} opts
 * @returns {Generator<string>}
 */
function* commandPathMatches(command, { platform = process.platform, env = process.env } = {}) {
  const raw = String(command || "").trim();
  if (!raw) return;
  const windows = platform === "win32";
  const names = windows ? windowsCommandNames(raw, envValue(env, "PATHEXT")) : [raw];
  if (windows ? /[\\/]/u.test(raw) : raw.includes("/")) {
    for (const name of names) {
      if (isRunnableFile(name, platform)) yield name;
    }
    return;
  }
  // POSIX environment names are case-sensitive; Windows looks PATH up in any case.
  const pathValue = windows ? envValue(env, "PATH") : String(env?.PATH ?? "");
  const seen = new Set();
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const dir = windows ? entry.trim().replace(/^"(.*)"$/u, "$1") : entry;
    // An empty entry would mean the current directory, which is never where a
    // dependency probe should find a toolchain.
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      const key = windows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isRunnableFile(candidate, platform)) yield candidate;
    }
  }
}

/**
 * Locate a command on PATH without spawning `which` or `where`: minimal
 * RHEL-family images (AlmaLinux, Rocky, Fedora, Amazon Linux containers) ship
 * no `which`, so a spawned probe reports present tools as missing. POSIX
 * accepts regular files the process may execute; Windows tries PATH x PATHEXT.
 * A name containing a path separator is checked as given.
 *
 * @param {string} command
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string | null} the first match, in PATH order
 */
export function findCommandOnPath(command, opts = {}) {
  for (const match of commandPathMatches(command, opts)) return match;
  return null;
}

/**
 * Every PATH match for a command, in lookup order (`which -a` semantics).
 *
 * @param {string} command
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string[]}
 */
export function listCommandsOnPath(command, opts = {}) {
  return [...commandPathMatches(command, opts)];
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
