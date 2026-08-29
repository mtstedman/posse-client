// @ts-check
// Minimal, SQLite-free repair path for Posse's own npm dependency tree. Do not
// add imports from provider/settings/runtime graphs here: Windows must be able
// to replace native addons before any of them are loaded.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  DEPENDENCY_INSTALL_ENV_PREFIXES,
  DEPENDENCY_SYNC_INSTALL_ENV_KEYS,
} from "../../../catalog/process.js";
import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";
import { managedInstallStateRoot } from "../../../shared/platform/functions/managed-install-state.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";

const NODE_MANIFEST_STAMP_NAME = ".posse-manifest.sha256";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function dirExists(dirPath) {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function hashFile(filePath) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); } catch { return ""; }
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageDir(root, name) {
  const value = String(name || "");
  if (value.startsWith("@")) {
    const [scope, pkg] = value.split("/");
    return path.join(root, "node_modules", scope, pkg || "");
  }
  return path.join(root, "node_modules", value);
}

function nodeManifestHash(root) {
  const names = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
  const files = names.map((name) => path.join(root, name)).filter(fileExists);
  if (files.length === 0) return "";
  const payload = files.map((file) => {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (rel !== "package.json") return `${rel}\0${hashFile(file)}`;
    const pkg = readJson(file) || {};
    return `${rel}\0${stableJson({
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
      overrides: pkg.overrides || {},
      packageManager: pkg.packageManager || "",
      peerDependencies: pkg.peerDependencies || {},
      peerDependenciesMeta: pkg.peerDependenciesMeta || {},
      resolutions: pkg.resolutions || {},
      workspaces: pkg.workspaces || null,
    })}`;
  }).join("\n");
  return hashText(payload);
}

function inspectPosseNodeTree(root) {
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return { present: false, ok: false, status: "failed", message: `missing ${path.join(root, "package.json")}` };
  const nodeModules = path.join(root, "node_modules");
  const required = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const optional = Object.keys(pkg.optionalDependencies || {});
  const missingRequired = required.filter((name) => !dirExists(packageDir(root, name)));
  const missingOptional = optional.filter((name) => !dirExists(packageDir(root, name)));
  const lock = readJson(path.join(root, "npm-shrinkwrap.json")) || readJson(path.join(root, "package-lock.json"));
  const missingLocked = Object.entries(lock?.packages || {})
    .filter(([relative, metadata]) => {
      const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\.\//u, "");
      return normalized.split("/").includes("node_modules")
        && metadata?.optional !== true
        && !dirExists(path.join(root, ...normalized.split("/")));
    })
    .map(([relative]) => relative);
  const manifestHash = nodeManifestHash(root);
  let installedHash = "";
  try { installedHash = fs.readFileSync(path.join(nodeModules, NODE_MANIFEST_STAMP_NAME), "utf8").trim(); } catch {}
  const missingNodeModules = !dirExists(nodeModules);
  const stale = Boolean(installedHash && manifestHash && installedHash !== manifestHash);
  const needsStamp = Boolean(!missingNodeModules && manifestHash && !installedHash);
  const needsInstall = missingNodeModules
    || missingRequired.length > 0
    || missingLocked.length > 0
    || stale
    || needsStamp
    || (missingOptional.length > 0 && !installedHash);
  return {
    present: true,
    ok: missingRequired.length === 0 && missingLocked.length === 0,
    status: needsInstall ? "needs-install" : "ok",
    needsInstall,
    needsStamp,
    stale,
    missingNodeModules,
    missingRequired,
    missingOptional,
    missingLocked,
    manifestHash,
  };
}

function installEnvironment() {
  return filterProcessEnv(process.env, {
    allowedKeys: DEPENDENCY_SYNC_INSTALL_ENV_KEYS,
    allowedPrefixes: DEPENDENCY_INSTALL_ENV_PREFIXES,
  });
}

function terminateTree(child, force = false) {
  if (!child || child.exitCode != null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 5000,
      });
      if (killed.status === 0) return;
    } catch {}
  } else if (child.pid) {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); return; } catch {}
  }
  try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
}

function runNpm(args, { cwd, timeoutMs, onProgress }) {
  const env = installEnvironment();
  const spec = commandSpawnSpec("npm", args, { env });
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let child;
    let timer = null;
    let forceTimer = null;
    let settleTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(result);
    };
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, message: error?.message || String(error) });
      return;
    }
    const append = (chunk) => {
      const text = String(chunk || "");
      output = `${output}${text}`.slice(-32 * 1024);
      for (const line of text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) onProgress?.(line);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      const processError = /** @type {NodeJS.ErrnoException} */ (error);
      finish({ ok: false, message: `${processError.code || "spawn"}: ${processError.message || processError}` });
    });
    child.on("close", (status, signal) => finish({
      ok: !timedOut && status === 0,
      message: timedOut ? `timed out after ${timeoutMs}ms` : (output.trim() || `exit ${status}${signal ? ` (${signal})` : ""}`),
    }));
    timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, false);
      forceTimer = setTimeout(() => terminateTree(child, true), 1000);
      forceTimer.unref?.();
      settleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish({ ok: false, message: `timed out after ${timeoutMs}ms; process tree did not report exit` });
      }, 6000);
      settleTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

function failureSummary(value) {
  const lines = String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => /\b(?:code|syscall|path|errno|EPERM|EACCES|EBUSY|ENOENT|ERESOLVE)\b|operation not permitted|permission denied|access is denied/iu.test(line));
  return (useful.length > 0 ? useful.slice(0, 6) : lines.slice(-3)).join(" | ").slice(0, 1200) || "npm failed";
}

/**
 * @param {{ posseRoot: string, dryRun?: boolean, adoptNodeInstall?: boolean, timeoutMs?: number, onProgress?: ((message: string) => void) | null }} input
 */
export async function repairPosseNodeTree({
  posseRoot,
  dryRun = false,
  adoptNodeInstall = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = null,
}) {
  const root = path.resolve(posseRoot);
  return await withDependencyInstallLock(root, async () => {
    const before = inspectPosseNodeTree(root);
    if (!before.present) return { ...before, label: "posse npm" };
    if (!before.needsInstall) return { ...before, label: "posse npm", action: "none", message: "node packages ready" };
    const canAdopt = adoptNodeInstall
      && before.needsStamp
      && !before.missingNodeModules
      && before.missingRequired.length === 0
      && before.missingLocked.length === 0
      && !before.stale;
    if (canAdopt && !dryRun) {
      try {
        fs.writeFileSync(path.join(root, "node_modules", NODE_MANIFEST_STAMP_NAME), `${before.manifestHash}\n`, "utf8");
      } catch (error) {
        return { ...before, label: "posse npm", ok: false, status: "failed", action: "stamp", message: `existing npm install looks healthy, but the dependency stamp could not be written: ${error?.code || error?.message || error}` };
      }
      return { ...before, label: "posse npm", ok: true, status: "installed", action: "stamp", message: "verified existing npm install" };
    }
    if (dryRun) return { ...before, label: "posse npm", ok: true, status: "dry-run", action: "install", message: "would run npm install" };

    const cacheKeySource = process.platform === "win32" ? root.toLowerCase() : root;
    const cacheDir = path.join(managedInstallStateRoot(root), "deps", "npm-cache", hashText(cacheKeySource).slice(0, 12));
    const args = ["install", "--include=optional", "--no-save", "--cache", cacheDir, "--no-fund", "--no-audit"];
    onProgress?.("posse npm: npm install");
    let run = await runNpm(args, { cwd: root, timeoutMs, onProgress });
    if (!run.ok && /\bERESOLVE\b|unable to resolve dependency tree|conflicting peer dependency/iu.test(run.message)) {
      onProgress?.("posse npm: retrying with legacy peer dependencies");
      run = await runNpm([...args.slice(0, 2), "--legacy-peer-deps", ...args.slice(2)], { cwd: root, timeoutMs, onProgress });
    }
    if (!run.ok) return { ...before, label: "posse npm", ok: false, status: "failed", action: "install", message: `npm install failed: ${failureSummary(run.message)}` };

    const after = inspectPosseNodeTree(root);
    if (!after.ok) {
      return { ...after, label: "posse npm", ok: false, status: "failed", action: "install", message: `missing packages after npm install: ${[...after.missingRequired, ...after.missingLocked].join(", ")}` };
    }
    try {
      fs.writeFileSync(path.join(root, "node_modules", NODE_MANIFEST_STAMP_NAME), `${after.manifestHash || before.manifestHash}\n`, "utf8");
    } catch (error) {
      return { ...after, label: "posse npm", ok: false, status: "failed", action: "stamp", message: `npm installed, but dependency stamp could not be written: ${error?.code || error?.message || error}` };
    }
    return { ...after, label: "posse npm", ok: true, status: "installed", action: "install", message: "npm install completed" };
  }, { dryRun, waitMs: timeoutMs, onProgress });
}
