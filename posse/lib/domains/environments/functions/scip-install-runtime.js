// @ts-check

import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { DEFAULT_POSSE_ROOT } from "../../runtime/functions/python-runtime.js";

export { DEFAULT_POSSE_ROOT };

export const DEFAULT_SCIP_COMMAND_TIMEOUT_MS = 600_000;

const UNBOUNDED_TIMEOUT_VALUES = new Set(["", "0", "false", "none", "off", "unbounded", "unlimited", "infinite"]);
const SCIP_DEPENDENCY_INSTALL_ENV_ALLOWLIST = new Set([
  "all_proxy",
  "appdata",
  "comspec",
  "curl_ca_bundle",
  "home",
  "homedrive",
  "homepath",
  "http_proxy",
  "https_proxy",
  "lang",
  "lc_all",
  "lc_ctype",
  "localappdata",
  "no_proxy",
  "npm_config_cafile",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "npm_config_proxy",
  "path",
  "pathext",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "requests_ca_bundle",
  "shell",
  "ssl_cert_dir",
  "ssl_cert_file",
  "systemroot",
  "temp",
  "term",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
  "cargo_home",
  "goprivate",
  "gonoproxy",
  "gonosumdb",
  "goproxy",
  "gosumdb",
  "rustup_home",
]);
const SCIP_DEPENDENCY_INSTALL_ENV_PREFIXES = ["pip_"];

/**
 * Narrow process-local cache: command PATH probes are stable within one
 * installer pass and otherwise spawn many duplicate `where`/`which` probes.
 */
const commandOnPathCache = new Map();

/**
 * @param {number | string | boolean | null | undefined} value
 * @param {number | null} [fallback]
 * @returns {number | null}
 */
export function normalizeCommandTimeoutMs(value, fallback = DEFAULT_SCIP_COMMAND_TIMEOUT_MS) {
  if (value === null || value === false) return null;
  if (typeof value === "string" && UNBOUNDED_TIMEOUT_VALUES.has(value.trim().toLowerCase())) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1000, Math.floor(parsed));
  return fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function scipDependencyInstallEnv(sourceEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value == null) continue;
    const normalizedKey = String(key).toLowerCase();
    if (
      !SCIP_DEPENDENCY_INSTALL_ENV_ALLOWLIST.has(normalizedKey)
      && !SCIP_DEPENDENCY_INSTALL_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
    ) continue;
    env[key] = String(value);
  }
  return env;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number | string | boolean | null }} [options]
 * @returns {Promise<{ ok: boolean, message: string, status?: number | null, signal?: NodeJS.Signals | null }>}
 */
export async function runCommand(command, args, {
  cwd = undefined,
  env = scipDependencyInstallEnv(),
  timeoutMs = DEFAULT_SCIP_COMMAND_TIMEOUT_MS,
} = {}) {
  const spawnSpec = await spawnSpecForCommand(command, args, env);
  const effectiveTimeoutMs = normalizeCommandTimeoutMs(timeoutMs, null);
  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, message: err?.message || String(err), status: null, signal: null });
      return;
    }

    if (effectiveTimeoutMs != null) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* child may already be gone */ }
      }, effectiveTimeoutMs);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => {
      stdout = tail(`${stdout}${chunk}`, 8192);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(`${stderr}${chunk}`, 8192);
    });
    child.on("error", (err) => {
      finish({ ok: false, message: err?.message || String(err), status: null, signal: null });
    });
    child.on("close", (status, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          message: `timed out after ${effectiveTimeoutMs}ms`,
          status,
          signal,
        });
        return;
      }
      if (status !== 0) {
        finish({
          ok: false,
          message: tail(String(stderr || stdout || `exit ${status}`), 1200).trim(),
          status,
          signal,
        });
        return;
      }
      finish({
        ok: true,
        message: tail(String(stdout || ""), 1200).trim(),
        status,
        signal,
      });
    });
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ command: string, args: string[] }>}
 */
export async function spawnSpecForCommand(command, args, env) {
  const resolved = await resolveWindowsCommand(command, env);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(String(resolved || ""))) {
    return {
      command: env?.ComSpec || env?.COMSPEC || process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", resolved, ...args],
    };
  }
  return { command: resolved, args };
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>}
 */
export async function resolveWindowsCommand(command, env) {
  const raw = String(command || "");
  if (process.platform !== "win32") return raw;
  if (!raw || raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw)) return raw;
  try {
    const result = await collectProbe("where", [raw], { env });
    const first = String(result.stdout || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return first || raw;
  } catch {
    return raw;
  }
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<boolean>}
 */
export async function commandOnPath(command, env = scipDependencyInstallEnv()) {
  const cacheKey = `${command}\0${pathEnvValue(env)}`;
  if (commandOnPathCache.has(cacheKey)) {
    return commandOnPathCache.get(cacheKey);
  }
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await collectProbe(probe, [command], { env, stdio: "ignore" });
  const ok = result.status === 0;
  commandOnPathCache.set(cacheKey, ok);
  return ok;
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function commandOnPathSync(command, env = scipDependencyInstallEnv()) {
  const cacheKey = `${command}\0${pathEnvValue(env)}`;
  if (commandOnPathCache.has(cacheKey)) {
    return commandOnPathCache.get(cacheKey);
  }
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { env, stdio: "ignore", windowsHide: true });
  const ok = result.status === 0;
  commandOnPathCache.set(cacheKey, ok);
  return ok;
}

export function clearCommandOnPathCache(command) {
  for (const key of commandOnPathCache.keys()) {
    if (key.startsWith(`${command}\0`)) commandOnPathCache.delete(key);
  }
}

export function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function composerBin(platform = process.platform) {
  return "composer";
}

export function commandPath(posseRoot, segments, command, platform = process.platform) {
  const ext = platform === "win32" ? ".cmd" : "";
  return path.join(posseRoot, ...segments, `${command}${ext}`);
}

export function expectedCommandPath(posseRoot, segments, command, platform = process.platform) {
  return commandPath(posseRoot, segments, command, platform);
}

export function findCommandPath(posseRoot, segments, command, platform = process.platform) {
  const dir = path.join(posseRoot, ...segments);
  for (const ext of commandExts(platform)) {
    const candidate = path.join(dir, `${command}${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function commandExts(platform = process.platform) {
  return platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
}

export function fileExists(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function tail(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(text.length - max) : text;
}

function pathEnvValue(env = {}) {
  const key = Object.keys(env || {}).find((name) => name.toLowerCase() === "path");
  return key ? String(env[key] || "") : "";
}

function collectProbe(command, args, { env = scipDependencyInstallEnv(), stdio = "pipe" } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: stdio === "ignore" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: 1, stdout: "", stderr: err?.message || String(err) });
      return;
    }
    child.stdout?.on("data", (chunk) => {
      stdout = tail(`${stdout}${chunk}`, 8192);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(`${stderr}${chunk}`, 8192);
    });
    child.on("error", (err) => {
      resolve({ status: 1, stdout, stderr: err?.message || String(err) });
    });
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}
