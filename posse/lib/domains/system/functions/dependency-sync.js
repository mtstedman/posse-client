// @ts-check
//
// Boot-time dependency repair. This keeps startup honest by syncing local
// package environments to checked-in manifests before workers start using
// SCIP, registered tests, or repo-local toolchains.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

import {
  DEPENDENCY_INSTALL_ENV_PREFIXES,
  DEPENDENCY_SYNC_INSTALL_ENV_KEYS,
} from "../../../catalog/process.js";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { reconcileNativeBinaries } from "../../../shared/native/functions/binary-reconciliation.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { gitExec } from "../../git/functions/utils.js";
import { installScipLanguageDependencies } from "../../atlas/functions/v2/scip/dependencies.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import {
  DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS,
  inspectJinaModel as inspectJinaModelDefault,
  pullJinaModel as pullJinaModelDefault,
} from "../../atlas/functions/v2/embeddings/jina-model.js";
import {
  DEFAULT_POSSE_ROOT,
  getPythonToolchainExecutable,
  listPythonProjectManifests,
  resolveManagedPythonRuntimeForProject,
} from "../../runtime/functions/python-runtime.js";
import { ensureManagedPythonToolchain } from "../../environments/functions/python-toolchain-install.js";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";
import {
  filterProcessEnv,
  isUnboundedCommandTimeout,
} from "../../../shared/platform/functions/process-env.js";
import {
  managedInstallStateRoot,
  managedToolRoot,
} from "../../../shared/platform/functions/managed-install-state.js";

const DEPENDENCY_SYNC_WORKER_URL = new URL("./dependency-sync-worker.js", import.meta.url);
const DEPENDENCY_SYNC_THREAD_MANAGER = new ThreadManager();

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_DOCTOR_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_TIMEOUT_FORCE_KILL_GRACE_MS = 1000;
const COMMAND_TIMEOUT_SETTLE_GRACE_MS = 1000;
const NODE_MANIFEST_STAMP_NAME = ".posse-manifest.sha256";
const COMPOSER_MANIFEST_STAMP_NAME = ".posse-manifest.sha256";
/**
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function dependencyInstallEnv(sourceEnv = process.env) {
  return filterProcessEnv(sourceEnv, {
    allowedKeys: DEPENDENCY_SYNC_INSTALL_ENV_KEYS,
    allowedPrefixes: DEPENDENCY_INSTALL_ENV_PREFIXES,
  });
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function hashFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
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

function uniqueByPath(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const root = path.resolve(entry.root || "");
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (!root || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, root });
  }
  return out;
}

const DEPENDENCY_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
]);

function hasNodeLock(root) {
  return fileExists(path.join(root, "package-lock.json"))
    || fileExists(path.join(root, "npm-shrinkwrap.json"))
    || fileExists(path.join(root, "pnpm-lock.yaml"))
    || fileExists(path.join(root, "yarn.lock"))
    || fileExists(path.join(root, "bun.lockb"))
    || fileExists(path.join(root, "bun.lock"));
}

function discoverLockBackedNodeRoots(projectDir, { maxDepth = 3, maxRoots = 16 } = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < maxRoots) {
    const { dir, depth } = stack.pop();
    if (!dir) continue;
    if (fileExists(path.join(dir, "package.json")) && hasNodeLock(dir)) {
      const rel = path.relative(root, dir).replace(/\\/g, "/") || ".";
      out.push({ root: dir, label: rel === "." ? "repo npm" : `repo npm:${rel}` });
      if (dir !== root) continue;
    }
    if (depth >= maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DEPENDENCY_SCAN_SKIP_DIRS.has(entry.name)) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return out;
}

function packageNames(pkg) {
  const required = Object.keys({
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  });
  const optional = Object.keys(pkg?.optionalDependencies || {});
  return { required, optional };
}

function packageDir(root, name) {
  const value = String(name || "");
  if (value.startsWith("@")) {
    const [scope, pkg] = value.split("/");
    return path.join(root, "node_modules", scope, pkg || "");
  }
  return path.join(root, "node_modules", value);
}

function detectPackageManager(root, pkg) {
  const declared = String(pkg?.packageManager || "").trim().toLowerCase();
  if (declared.startsWith("pnpm@")) return "pnpm";
  if (declared.startsWith("yarn@")) return "yarn";
  if (declared.startsWith("bun@")) return "bun";
  if (fileExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(root, "yarn.lock"))) return "yarn";
  if (fileExists(path.join(root, "bun.lockb")) || fileExists(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

function nodeManifestFiles(root) {
  return [
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
    path.join(root, "npm-shrinkwrap.json"),
    path.join(root, "pnpm-lock.yaml"),
    path.join(root, "yarn.lock"),
    path.join(root, "bun.lockb"),
    path.join(root, "bun.lock"),
  ].filter(fileExists);
}

function nodeManifestHash(root) {
  const files = nodeManifestFiles(root);
  if (files.length === 0) return "";
  const payload = files.map((file) => {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (rel === "package.json") {
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
    }
    return `${rel}\0${hashFile(file)}`;
  }).join("\n");
  return hashText(payload);
}

function nodeManifestStampPath(root) {
  return path.join(root, "node_modules", NODE_MANIFEST_STAMP_NAME);
}

function readNodeManifestStamp(root) {
  try {
    return fs.readFileSync(nodeManifestStampPath(root), "utf8").trim();
  } catch {
    return "";
  }
}

function writeNodeManifestStamp(root, hash) {
  if (!hash) return;
  const stamp = nodeManifestStampPath(root);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, `${hash}\n`, "utf8");
}

function composerManifestFiles(root) {
  return [
    path.join(root, "composer.json"),
    path.join(root, "composer.lock"),
  ].filter(fileExists);
}

function composerManifestHash(root) {
  const files = composerManifestFiles(root);
  if (files.length === 0) return "";
  const payload = files.map((file) => {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    return `${rel}\0${hashFile(file)}`;
  }).join("\n");
  return hashText(payload);
}

function composerManifestStampPath(root) {
  return path.join(root, "vendor", "composer", COMPOSER_MANIFEST_STAMP_NAME);
}

function readComposerManifestStamp(root) {
  try {
    return fs.readFileSync(composerManifestStampPath(root), "utf8").trim();
  } catch {
    return "";
  }
}

function writeComposerManifestStamp(root, hash) {
  if (!hash) return;
  const stamp = composerManifestStampPath(root);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, `${hash}\n`, "utf8");
}

function packageManagerCommand(manager) {
  return manager === "pnpm" ? "pnpm"
    : manager === "yarn" ? "yarn"
      : manager === "bun" ? "bun"
        : "npm";
}

function nodeInstallCacheDir(root, opts = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const projectRoot = path.resolve(opts.projectDir || resolvedRoot);
  const relToProject = path.relative(projectRoot, resolvedRoot);
  const rootUnderProject = !relToProject || (!relToProject.startsWith("..") && !path.isAbsolute(relToProject));
  const baseRoot = rootUnderProject ? projectRoot : resolvedRoot;
  const key = hashText(resolvedRoot.toLowerCase()).slice(0, 12);
  return path.join(managedInstallStateRoot(baseRoot), "deps", "npm-cache", key);
}

function installArgsForPackageManager(manager, root, opts = {}) {
  if (manager === "bun") return ["install"];
  if (manager === "npm") {
    return ["install", "--include=optional", "--no-save", "--cache", nodeInstallCacheDir(root, opts)];
  }
  return ["install"];
}

function missingNodePackageNames(report) {
  return [...(report?.missing_required || []), ...(report?.missing_optional || [])];
}

function missingNodePackageLabels(report) {
  return [
    ...(report?.missing_required || []).map((name) => `required:${name}`),
    ...(report?.missing_optional || []).map((name) => `optional:${name}`),
  ];
}

function missingRequiredNodePackageLabels(report) {
  return (report?.missing_required || []).map((name) => `required:${name}`);
}

function missingOptionalNodePackageLabels(report) {
  return (report?.missing_optional || []).map((name) => `optional:${name}`);
}

function installArgsForMissingNodePackages(manager, root, missingNames, opts = {}) {
  if (manager !== "npm" || !Array.isArray(missingNames) || missingNames.length === 0) return null;
  return [
    "install",
    "--include=optional",
    "--legacy-peer-deps",
    "--no-save",
    "--cache",
    nodeInstallCacheDir(root, opts),
    ...missingNames,
  ];
}

function isNpmPeerDependencyConflict(run) {
  const text = cleanCommandOutput([
    run?.message || "",
    run?.stderr || "",
    run?.stdout || "",
  ].join("\n"));
  return /\bERESOLVE\b/iu.test(text)
    || /unable to resolve dependency tree/iu.test(text)
    || /conflicting peer dependency/iu.test(text)
    || /peer dep(?:endency)? conflict/iu.test(text);
}

function installArgsForPeerConflictRetry(manager, args, run) {
  if (manager !== "npm" || !Array.isArray(args) || args.includes("--legacy-peer-deps")) return null;
  if (!isNpmPeerDependencyConflict(run)) return null;
  const insertAt = Math.max(1, args.indexOf("--include=optional") + 1);
  return [
    ...args.slice(0, insertAt),
    "--legacy-peer-deps",
    ...args.slice(insertAt),
  ];
}

function commandOnPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command.replace(/\.(cmd|bat)$/iu, "")], {
    env: dependencyInstallEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function npmLockedPackageDirs(root, manager) {
  if (manager !== "npm") return [];
  const lock = readJson(path.join(root, "npm-shrinkwrap.json"))
    || readJson(path.join(root, "package-lock.json"));
  if (!lock?.packages || typeof lock.packages !== "object") return [];
  const dirs = [];
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\.\//u, "");
    if (!normalized || !normalized.split("/").includes("node_modules")) continue;
    if (metadata?.optional === true) continue;
    dirs.push(normalized);
  }
  return dirs;
}

function terminateDependencyCommand(child, { force = false } = {}) {
  if (!child || child.exitCode != null || (!force && child.killed)) return false;
  if (process.platform === "win32" && child.pid) {
    try {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      if (killed.status === 0) return true;
    } catch {
      // Fall through to child.kill best effort.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      // Fall through to child.kill best effort.
    }
  }
  try {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}

function inspectNodeProject(root) {
  const packageJson = path.join(root, "package.json");
  const pkg = readJson(packageJson);
  if (!pkg) return { present: false, root, ok: true, status: "skipped", reason: "no package.json" };

  const manager = detectPackageManager(root, pkg);
  const nodeModules = path.join(root, "node_modules");
  const lockCandidates = [
    path.join(root, "package-lock.json"),
    path.join(root, "npm-shrinkwrap.json"),
    path.join(root, "pnpm-lock.yaml"),
    path.join(root, "yarn.lock"),
    path.join(root, "bun.lockb"),
    path.join(root, "bun.lock"),
  ];
  const installStamp = path.join(nodeModules, ".package-lock.json");
  const manifestStamp = Math.max(
    safeMtimeMs(packageJson),
    ...lockCandidates.map(safeMtimeMs),
  );
  const installedStamp = safeMtimeMs(installStamp) || safeMtimeMs(nodeModules);
  const { required, optional } = packageNames(pkg);
  const missingRequired = required.filter((name) => !dirExists(packageDir(root, name)));
  const missingOptional = optional.filter((name) => !dirExists(packageDir(root, name)));
  const missingLocked = npmLockedPackageDirs(root, manager)
    .filter((relative) => !dirExists(path.join(root, ...relative.split("/"))));
  const missingNodeModules = !dirExists(nodeModules);
  const manifestHash = nodeManifestHash(root);
  const installedManifestHash = readNodeManifestStamp(root);
  const stale = Boolean(installedManifestHash && manifestHash && installedManifestHash !== manifestHash);
  const needsStamp = Boolean(!missingNodeModules && manifestHash && !installedManifestHash);
  const needsInstall = missingNodeModules
    || missingRequired.length > 0
    || missingLocked.length > 0
    || stale
    || needsStamp
    || (missingOptional.length > 0 && !installedManifestHash);

  return {
    present: true,
    root,
    ok: missingRequired.length === 0 && missingLocked.length === 0,
    status: needsInstall ? "needs-install" : "ok",
    manager,
    missing_node_modules: missingNodeModules,
    missing_required: missingRequired,
    missing_optional: missingOptional,
    missing_locked: missingLocked,
    stale,
    needs_stamp: needsStamp,
    manifest_hash: manifestHash,
    package_json: packageJson,
  };
}

function compact(value, max = 1600) {
  const text = cleanCommandOutput(value).trim();
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  const firstBreak = tail.search(/[\r\n]/u);
  return (firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail).trimStart();
}

function cleanCommandOutput(value) {
  return String(value || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r(?!\n)/gu, "\n");
}

function outputLines(value) {
  return cleanCommandOutput(value)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstLine(value) {
  return outputLines(value)[0] || "";
}

function prefixScipDependencyProgress(message) {
  const text = String(message || "").trim();
  if (!text) return "SCIP deps";
  return /^SCIP deps:/iu.test(text) ? text : `SCIP deps: ${text}`;
}

function gitRootForPath(root) {
  try {
    const text = String(gitExec(["rev-parse", "--show-toplevel"], root, { timeoutMs: 5000 }) || "").trim();
    return text ? path.resolve(text) : null;
  } catch {
    return null;
  }
}

function isInsideRoot(root, target) {
  const rel = path.relative(root, target).replace(/\\/g, "/");
  return Boolean(rel) && rel !== "." && !rel.startsWith("../") && !path.isAbsolute(rel);
}

function gitPathStatus(repoRoot, args) {
  try {
    gitExec(args, repoRoot, { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function gitignoreAlreadyHas(ignorePath, pattern) {
  let lines = [];
  try {
    lines = fs.readFileSync(ignorePath, "utf8").split(/\r?\n/u);
  } catch {
    lines = [];
  }
  const normalized = pattern.replace(/\/+$/u, "");
  return lines.some((line) => {
    const text = String(line || "").trim();
    if (!text || text.startsWith("#")) return false;
    return text === pattern || text.replace(/\/+$/u, "") === normalized;
  });
}

function appendGitignorePattern(ignorePath, pattern) {
  const existing = (() => {
    try { return fs.readFileSync(ignorePath, "utf8"); } catch { return ""; }
  })();
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
  fs.writeFileSync(ignorePath, `${existing}${prefix}${pattern}\n`, "utf8");
}

export function ensureGeneratedDirectoryIgnored(root, dirName, opts = {}) {
  if (opts.dryRun) return null;
  const absDir = path.resolve(root, dirName);
  if (!dirExists(absDir)) return null;

  const repoRoot = gitRootForPath(root);
  const ignoreRoot = repoRoot || path.resolve(root);
  if (!isInsideRoot(ignoreRoot, absDir)) return null;

  const rel = path.relative(ignoreRoot, absDir).replace(/\\/g, "/");
  const pattern = `${rel.replace(/\/+$/u, "")}/`;
  const ignorePath = path.join(ignoreRoot, ".gitignore");

  if (repoRoot) {
    if (gitPathStatus(repoRoot, ["ls-files", "--error-unmatch", "--", rel])) return null;
    if (gitPathStatus(repoRoot, ["check-ignore", "-q", "--", rel])) return null;
  } else if (gitignoreAlreadyHas(ignorePath, pattern)) {
    return null;
  }

  try {
    appendGitignorePattern(ignorePath, pattern);
    opts.onProgress?.(`ignored generated dependency directory ${pattern}`);
    return { path: ignorePath, pattern };
  } catch (error) {
    const warning = `could not update ${ignorePath}: ${error?.code || error?.message || error}`;
    opts.onProgress?.(`warning: ${warning}`);
    return { path: ignorePath, pattern, warning };
  }
}

export function summarizeNodeFailure(value) {
  const lines = outputLines(value);
  const useful = lines.filter((line) => (
    /^(?:npm (?:error|ERR!))?\s*(?:code|syscall|path|errno)\b/iu.test(line)
    || /\b(?:EPERM|EACCES|EBUSY|ENOENT|ERESOLVE)\b/iu.test(line)
    || /operation not permitted|permission denied|access is denied|could not resolve dependency/iu.test(line)
  ));
  const selected = useful.length > 0 ? useful.slice(0, 6) : lines.slice(-3);
  return compact(selected.join(" | "), 1200) || "npm failed";
}

function summarizeComposerFailure(value) {
  const text = cleanCommandOutput(value);
  const missingExtensions = new Set();
  for (const match of text.matchAll(/\b(?:requires|require)\s+(ext-[A-Za-z0-9_.-]+)\b/giu)) {
    missingExtensions.add(match[1].toLowerCase());
  }
  for (const match of text.matchAll(/\b--ignore-platform-req=(ext-[A-Za-z0-9_.-]+)\b/giu)) {
    missingExtensions.add(match[1].toLowerCase());
  }
  for (const match of text.matchAll(/\b(?:PHP\s+extension|extension)\s+(ext-[A-Za-z0-9_.-]+)\b/giu)) {
    missingExtensions.add(match[1].toLowerCase());
  }

  const parts = [];
  if (missingExtensions.size > 0) {
    parts.push(`missing PHP extension(s): ${[...missingExtensions].sort().join(", ")}. Install or enable them for the PHP binary Composer uses.`);
  }
  if (/zip extension and unzip\/7z commands are both missing/iu.test(text)) {
    parts.push("missing PHP extension ext-zip or an unzip/7z command; Composer cannot extract package archives and may fall back to slow source clones.");
  }
  if (/process timed out|exceeded the timeout of\s+\d+\s+seconds|process-timeout/iu.test(text)) {
    parts.push("Composer hit its own process-timeout while running a child process.");
  }
  if (/PHP curl extension enabled/iu.test(text)) {
    parts.push("PHP curl extension is disabled; Composer will run slowly.");
  }
  if (parts.length > 0) return parts.join(" ");

  const lines = outputLines(text);
  const useful = [...lines].reverse().find((line) => (
    /requirements could not be resolved|missing from your system|install or enable|platform req|failed|error/iu.test(line)
      && !/No composer\.lock file present/iu.test(line)
  ));
  return useful || firstLine(text) || "Composer failed";
}

function normalizeCommandTimeoutMs(value, fallback = DEFAULT_COMMAND_TIMEOUT_MS) {
  if (isUnboundedCommandTimeout(value)) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1000, parsed);
  return fallback;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number | null, onProgress?: ((message: string) => void) | null }} [opts]
 */
async function runCommand(command, args, {
  cwd,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  onProgress = null,
} = {}) {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let child;
    let timer = null;
    let forceTimer = null;
    let settleTimer = null;
    let onSigint = null;
    let onSigterm = null;
    const env = dependencyInstallEnv();
    const spawnSpec = commandSpawnSpec(command, args, { env });
    const removeSignalHandlers = () => {
      if (onSigint) process.off("SIGINT", onSigint);
      if (onSigterm) process.off("SIGTERM", onSigterm);
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      removeSignalHandlers();
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(result);
    };
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({ ok: false, message: err?.message || String(err), stdout: "", stderr: "" });
      return;
    }

    const forwardSignal = (signal) => {
      removeSignalHandlers();
      terminateDependencyCommand(child, { force: true });
      setImmediate(() => {
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        }
      });
    };
    onSigint = () => forwardSignal("SIGINT");
    onSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const effectiveTimeoutMs = normalizeCommandTimeoutMs(timeoutMs, null);
    timer = effectiveTimeoutMs == null ? null : setTimeout(() => {
      timedOut = true;
      terminateDependencyCommand(child, { force: false });
      forceTimer = setTimeout(() => {
        terminateDependencyCommand(child, { force: true });
        settleTimer = setTimeout(() => {
          finish({
            ok: false,
            code: null,
            signal: null,
            stdout,
            stderr,
            message: `timed out after ${effectiveTimeoutMs}ms`,
          });
        }, COMMAND_TIMEOUT_SETTLE_GRACE_MS);
        settleTimer?.unref?.();
      }, COMMAND_TIMEOUT_FORCE_KILL_GRACE_MS);
      forceTimer?.unref?.();
    }, effectiveTimeoutMs);
    timer?.unref?.();

    const onData = (kind, chunk) => {
      const text = String(chunk || "");
      if (kind === "stdout") stdout = compact(`${stdout}${text}`, 8000);
      else stderr = compact(`${stderr}${text}`, 8000);
      const line = firstLine(text.split(/\r?\n/u).reverse().join("\n"));
      if (line && typeof onProgress === "function") {
        try { onProgress(line); } catch { /* progress only */ }
      }
    };
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream) stdoutStream.on("data", (chunk) => onData("stdout", chunk));
    if (stderrStream) stderrStream.on("data", (chunk) => onData("stderr", chunk));
    child.on("error", (err) => {
      finish({ ok: false, message: err?.message || String(err), stdout, stderr });
    });
    child.on("close", (code, signal) => {
      const ok = !timedOut && code === 0;
      const message = timedOut
        ? `timed out after ${effectiveTimeoutMs}ms`
        : compact(stderr || stdout || (signal ? `signal ${signal}` : `exit ${code}`));
      finish({ ok, code, signal, stdout, stderr, message });
    });
  });
}

async function ensureNodeProject(entry, opts) {
  const before = inspectNodeProject(entry.root);
  if (!before.present) return before;
  const command = packageManagerCommand(before.manager);
  const args = installArgsForPackageManager(before.manager, entry.root, opts);
  const installLabel = `${before.manager} ${args[0] || "install"}`;
  if (before.status === "ok" && opts.forceNodeInstall !== true) {
    return { ...before, label: entry.label, action: "none", message: "node packages ready" };
  }
  const canAdoptExistingInstall = opts.adoptNodeInstall === true
    && opts.forceNodeInstall !== true
    && before.needs_stamp === true
    && before.missing_node_modules !== true
    && before.missing_required.length === 0
    && before.missing_locked.length === 0
    && before.stale !== true;
  if (canAdoptExistingInstall && !opts.dryRun) {
    writeNodeManifestStamp(entry.root, before.manifest_hash);
    const adopted = inspectNodeProject(entry.root);
    return {
      ...adopted,
      label: entry.label,
      ok: true,
      status: "installed",
      action: "stamp",
      message: "verified existing npm install",
    };
  }
  const reason = [
    opts.forceNodeInstall === true ? "repair explicitly requested" : "",
    before.missing_node_modules ? "missing node_modules" : "",
    before.missing_required.length ? `${before.missing_required.length} required missing` : "",
    before.missing_locked.length ? `${before.missing_locked.length} locked transitive missing` : "",
    before.missing_optional.length ? `${before.missing_optional.length} optional missing` : "",
    before.stale ? "manifest newer than install" : "",
    before.needs_stamp ? "install tree not verified" : "",
  ].filter(Boolean).join(", ");

  if (!commandOnPath(command)) {
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `${before.manager} is not available on PATH` };
  }
  if (opts.dryRun) {
    return { ...before, label: entry.label, ok: true, status: "dry-run", action: "install", message: `would run ${installLabel} (${reason})` };
  }

  opts.onProgress?.(`${entry.label}: ${installLabel}`);
  const run = await runCommand(command, args, {
    cwd: entry.root,
    timeoutMs: opts.timeoutMs,
    onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
  });
  let generatedIgnore = null;
  let usedPeerConflictRetry = false;
  if (!run.ok) {
    const peerRetryArgs = installArgsForPeerConflictRetry(before.manager, args, run);
    if (!peerRetryArgs) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `${installLabel} failed: ${summarizeNodeFailure(run.message)}` };
    }
    opts.onProgress?.(`${entry.label}: ${before.manager} install with legacy peer deps`);
    const peerRetry = await runCommand(command, peerRetryArgs, {
      cwd: entry.root,
      timeoutMs: opts.timeoutMs,
      onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
    });
    if (!peerRetry.ok) {
      return {
        ...before,
        label: entry.label,
        ok: false,
        status: "failed",
        action: "install",
        generated_ignore: generatedIgnore,
        message: `${installLabel} failed after peer dependency retry: ${summarizeNodeFailure(peerRetry.message || run.message)}`,
      };
    }
    usedPeerConflictRetry = true;
  }
  generatedIgnore = before.missing_node_modules
    ? ensureGeneratedDirectoryIgnored(entry.root, "node_modules", opts)
    : null;
  let after = inspectNodeProject(entry.root);
  let missingAfter = missingNodePackageLabels(after);
  let usedFocusedRetry = false;
  const retryArgs = installArgsForMissingNodePackages(before.manager, entry.root, missingNodePackageNames(after), opts);
  if (missingAfter.length > 0 && retryArgs) {
    opts.onProgress?.(`${entry.label}: ${before.manager} focused install ${missingNodePackageNames(after).join(", ")}`);
    const retry = await runCommand(command, retryArgs, {
      cwd: entry.root,
      timeoutMs: opts.timeoutMs,
      onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
    });
    if (!retry.ok) {
      if (missingRequiredNodePackageLabels(after).length === 0 && (after.missing_locked || []).length === 0) {
        const missingOptional = missingOptionalNodePackageLabels(after);
        const hash = after.manifest_hash || before.manifest_hash;
        if (!opts.dryRun) writeNodeManifestStamp(entry.root, hash);
        return {
          ...after,
          label: entry.label,
          ok: true,
          status: "installed",
          action: "install",
          generated_ignore: generatedIgnore,
          message: `${installLabel} completed${usedPeerConflictRetry ? " after peer dependency retry" : ""}; optional packages unavailable: ${missingOptional.join(", ")}`,
        };
      }
      return { ...after, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `${before.manager} focused install failed: ${summarizeNodeFailure(retry.message)}` };
    }
    after = inspectNodeProject(entry.root);
    missingAfter = missingNodePackageLabels(after);
    usedFocusedRetry = true;
  }
  const missingRequiredAfter = missingRequiredNodePackageLabels(after);
  const missingOptionalAfter = missingOptionalNodePackageLabels(after);
  const missingLockedAfter = after.missing_locked || [];
  const packagesOk = missingRequiredAfter.length === 0 && missingLockedAfter.length === 0;
  if (packagesOk && !opts.dryRun) writeNodeManifestStamp(entry.root, after.manifest_hash || before.manifest_hash);
  const retryDetails = [
    usedPeerConflictRetry ? "peer dependency retry" : "",
    usedFocusedRetry ? "focused retry" : "",
  ].filter(Boolean);
  return {
    ...after,
    label: entry.label,
    ok: packagesOk,
    status: packagesOk ? "installed" : "failed",
    action: "install",
    generated_ignore: generatedIgnore,
    message: packagesOk
      ? `${installLabel} completed${retryDetails.length ? ` after ${retryDetails.join(" and ")}` : ""}${missingOptionalAfter.length ? `; optional packages unavailable: ${missingOptionalAfter.join(", ")}` : ""}`
      : `missing packages after install: ${[...missingRequiredAfter, ...missingLockedAfter.map((name) => `locked:${name}`)].join(", ")}`,
  };
}

function resolvePythonCommand(projectRoot = process.cwd()) {
  const roots = [path.resolve(projectRoot || process.cwd())];
  const candidates = [];
  for (const root of roots) {
    if (process.platform === "win32") {
      candidates.push({ command: path.join(root, ".venv", "Scripts", "python.exe"), args: [] });
      candidates.push({ command: path.join(root, "venv", "Scripts", "python.exe"), args: [] });
    } else {
      candidates.push({ command: path.join(root, ".venv", "bin", "python"), args: [] });
      candidates.push({ command: path.join(root, "venv", "bin", "python"), args: [] });
    }
  }
  candidates.push(...(process.platform === "win32"
    ? [
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    ]
    : [
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ]));
  // Posse-managed CPython toolchain (installed by doctor when nothing above
  // resolves) sits last so a user-installed Python always wins.
  candidates.push({ command: getPythonToolchainExecutable(roots[0]), args: [] });
  for (const candidate of candidates) {
    if (candidate.command.includes(path.sep) && !fileExists(candidate.command)) continue;
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if ((result.status ?? 1) === 0) return candidate;
  }
  return null;
}

function inspectPythonProject(root, opts = {}) {
  const runtime = resolveManagedPythonRuntimeForProject({
    projectDir: root,
    posseRoot: opts.posseRoot || DEFAULT_POSSE_ROOT,
    assumePython: opts.assumePython === true,
  });
  if (!runtime) {
    return { present: false, root, ok: true, status: "skipped", reason: "no Python project manifests" };
  }
  return {
    present: true,
    root,
    ok: runtime.ready,
    status: runtime.ready ? "ok" : "needs-install",
    manifests: (runtime.manifests || []).map((manifest) => manifest.name),
    requirements: runtime.requirements,
    requirements_hash: runtime.requirementsHash,
    python: runtime.python,
    stamp_path: runtime.stampPath,
    runtime_dir: runtime.runtimeDir,
    runtime_bin_dir: runtime.binDir,
  };
}

// `pip install -e .` only makes sense when the manifest actually declares a
// buildable package; a config-only pyproject.toml (just [tool.*] tables) would
// otherwise make pip synthesize a junk setuptools package.
function pythonEditableInstallable(root, manifests = []) {
  const names = new Set(manifests);
  if (names.has("setup.py")) return true;
  if (!names.has("pyproject.toml")) return false;
  let source = "";
  try { source = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8"); } catch { return false; }
  return /^\s*\[(?:project|build-system|tool\.poetry)[\].]/mu.test(source);
}

function samePath(a, b) {
  const left = path.resolve(String(a || ""));
  const right = path.resolve(String(b || ""));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function ensurePythonProject(entry, opts) {
  const inspectOpts = { ...opts, assumePython: entry.assumePython === true };
  const before = inspectPythonProject(entry.root, inspectOpts);
  if (!before.present) return before;
  // The project repo's runtime must carry the approved test runner even when
  // it was provisioned before doctor learned to install pytest (the manifest
  // stamp stays valid, so the full install path below never re-runs for it).
  const needsPytest = samePath(entry.root, opts.projectDir || entry.root);
  if (before.status === "ok") {
    if (needsPytest && !probeCommandOk(before.python, ["-m", "pytest", "--version"])) {
      if (opts.dryRun) {
        return { ...before, label: entry.label, ok: true, status: "dry-run", action: "install", message: "would install pytest into the existing managed Python runtime" };
      }
      opts.onProgress?.(`${entry.label}: installing pytest test runner`);
      const pytestInstall = await runCommand(before.python, ["-m", "pip", "install", "pytest"], {
        cwd: entry.root,
        timeoutMs: opts.timeoutMs,
        onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
      });
      if (!pytestInstall.ok) {
        return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `pip install pytest failed: ${firstLine(pytestInstall.message)}` };
      }
      return { ...before, label: entry.label, ok: true, status: "installed", action: "install", message: "pytest installed into existing python environment" };
    }
    return { ...before, label: entry.label, action: "none", message: "python environment ready" };
  }
  const dependencyInstall = before.requirements
    ? { args: ["-m", "pip", "install", "-r", before.requirements], detail: `pip install -r ${path.basename(before.requirements)}` }
    : (pythonEditableInstallable(entry.root, before.manifests)
      ? { args: ["-m", "pip", "install", "-e", "."], detail: "pip install -e ." }
      : null);
  let basePython = resolvePythonCommand(opts.posseRoot);
  if (opts.dryRun) {
    const steps = [
      basePython ? "" : "download managed CPython",
      "create Posse-managed Python runtime",
      dependencyInstall?.detail || "",
      "ensure pytest",
    ].filter(Boolean).join(", ");
    return { ...before, label: entry.label, ok: true, status: "dry-run", action: "install", message: `would ${steps}` };
  }
  if (!basePython) {
    opts.onProgress?.(`${entry.label}: Python not found; installing managed CPython toolchain`);
    const toolchain = await ensureManagedPythonToolchain({
      posseRoot: opts.posseRoot,
      timeoutMs: opts.timeoutMs,
      onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
    });
    if (!toolchain.ok) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `Python is not available on PATH and the managed CPython install failed: ${firstLine(toolchain.message)}` };
    }
    basePython = resolvePythonCommand(opts.posseRoot);
    if (!basePython) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: "managed CPython installed but python is still not resolvable" };
    }
  }

  opts.onProgress?.(`${entry.label}: python runtime ${path.basename(before.runtime_dir)}`);
  fs.mkdirSync(path.dirname(before.runtime_dir), { recursive: true });
  const create = await runCommand(basePython.command, [...basePython.args, "-m", "venv", before.runtime_dir], {
    cwd: opts.posseRoot,
    timeoutMs: opts.timeoutMs,
    onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
  });
  if (!create.ok) {
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `python -m venv failed: ${firstLine(create.message)}` };
  }
  if (dependencyInstall) {
    const pip = await runCommand(before.python, dependencyInstall.args, {
      cwd: entry.root,
      timeoutMs: opts.timeoutMs,
      onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
    });
    if (!pip.ok) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `${dependencyInstall.detail} failed: ${firstLine(pip.message)}` };
    }
  }
  // The approved Python test runner is pytest (`python -m pytest`); make sure
  // the managed runtime can run it even when the repo's manifests omit it.
  const pytestProbe = await runCommand(before.python, ["-m", "pytest", "--version"], {
    cwd: entry.root,
    timeoutMs: opts.timeoutMs,
  });
  if (!pytestProbe.ok) {
    opts.onProgress?.(`${entry.label}: installing pytest test runner`);
    const pytestInstall = await runCommand(before.python, ["-m", "pip", "install", "pytest"], {
      cwd: entry.root,
      timeoutMs: opts.timeoutMs,
      onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
    });
    if (!pytestInstall.ok) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `pip install pytest failed: ${firstLine(pytestInstall.message)}` };
    }
  }
  fs.mkdirSync(path.dirname(before.stamp_path), { recursive: true });
  fs.writeFileSync(before.stamp_path, `${before.requirements_hash}\n`, "utf8");
  const after = inspectPythonProject(entry.root, inspectOpts);
  return { ...after, label: entry.label, ok: after.status === "ok", status: after.status === "ok" ? "installed" : "failed", action: "install", message: `python environment installed (${dependencyInstall ? `${dependencyInstall.detail} + ` : ""}pytest)` };
}

function composerCommand(posseRoot) {
  const composer = "composer";
  if (commandOnPath(composer)) return { command: composer, args: [] };
  const phar = path.join(managedToolRoot(posseRoot), "scip", "bin", "composer.phar");
  if (commandOnPath("php") && fileExists(phar)) return { command: "php", args: [phar] };
  return null;
}

function inspectComposerProject(root) {
  const composerJson = path.join(root, "composer.json");
  if (!fileExists(composerJson)) return { present: false, root, ok: true, status: "skipped", reason: "no composer.json" };
  const vendor = path.join(root, "vendor");
  const installedJson = path.join(vendor, "composer", "installed.json");
  const composerLock = path.join(root, "composer.lock");
  const manifestStamp = Math.max(safeMtimeMs(composerJson), safeMtimeMs(composerLock));
  const installedStamp = safeMtimeMs(installedJson) || safeMtimeMs(vendor);
  const manifestHash = composerManifestHash(root);
  const installedManifestHash = readComposerManifestStamp(root);
  const missingVendor = !dirExists(vendor);
  const missingInstalled = !fileExists(installedJson);
  const staleByHash = Boolean(installedManifestHash && manifestHash && installedManifestHash !== manifestHash);
  const staleByMtime = Boolean(!installedManifestHash && installedStamp > 0 && manifestStamp > installedStamp + 1000);
  const needsStamp = Boolean(!missingVendor && !missingInstalled && !staleByHash && !staleByMtime && manifestHash && !installedManifestHash);
  const needsInstall = missingVendor || missingInstalled || staleByHash || staleByMtime || needsStamp;
  return {
    present: true,
    root,
    ok: !needsInstall,
    status: needsInstall ? "needs-install" : "ok",
    composer_json: composerJson,
    installed_json: installedJson,
    missing_vendor: missingVendor,
    missing_installed: missingInstalled,
    stale: staleByHash || staleByMtime,
    needs_stamp: needsStamp,
    manifest_hash: manifestHash,
  };
}

async function ensureComposerProject(entry, opts) {
  const before = inspectComposerProject(entry.root);
  if (!before.present) return before;
  if (before.status === "ok") {
    return { ...before, label: entry.label, action: "none", message: "composer dependencies ready" };
  }
  const composer = composerCommand(opts.posseRoot);
  if (!composer) {
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: "Composer/PHP is not available on PATH" };
  }
  if (opts.dryRun) {
    return { ...before, label: entry.label, ok: true, status: "dry-run", action: "install", message: "would run composer install" };
  }
  opts.onProgress?.(`${entry.label}: composer install`);
  const run = await runCommand(composer.command, [...composer.args, "install"], {
    cwd: entry.root,
    timeoutMs: opts.timeoutMs,
    onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
  });
  let generatedIgnore = null;
  if (!run.ok) {
    const detail = summarizeComposerFailure(`${run.stderr || ""}\n${run.stdout || ""}\n${run.message || ""}`);
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `composer install failed: ${detail}` };
  }
  generatedIgnore = before.missing_vendor
    ? ensureGeneratedDirectoryIgnored(entry.root, "vendor", opts)
    : null;
  let after = inspectComposerProject(entry.root);
  const dependenciesPresent = !after.missing_vendor && !after.missing_installed;
  if (dependenciesPresent && !opts.dryRun) {
    writeComposerManifestStamp(entry.root, after.manifest_hash || before.manifest_hash);
    after = inspectComposerProject(entry.root);
  }
  const ready = after.status === "ok";
  return {
    ...after,
    label: entry.label,
    ok: ready,
    status: ready ? "installed" : "failed",
    action: "install",
    generated_ignore: generatedIgnore,
    message: ready
      ? "composer install completed"
      : "composer install completed, but vendor/composer/installed.json is missing or stale",
  };
}

async function ensureSimpleCommandProject(entry, opts) {
  if (!fileExists(path.join(entry.root, entry.manifest))) {
    return { present: false, root: entry.root, ok: true, status: "skipped", reason: `no ${entry.manifest}` };
  }
  const stamp = path.join(entry.root, entry.stamp);
  const manifestStamp = safeMtimeMs(path.join(entry.root, entry.manifest));
  const installedStamp = safeMtimeMs(stamp);
  if (installedStamp > 0 && installedStamp >= manifestStamp) {
    return { present: true, root: entry.root, label: entry.label, ok: true, status: "ok", action: "none", message: `${entry.label} ready` };
  }
  if (!commandOnPath(entry.command)) {
    return { present: true, root: entry.root, label: entry.label, ok: false, status: "failed", action: "install", message: `${entry.command} is not available on PATH` };
  }
  if (opts.dryRun) {
    return { present: true, root: entry.root, label: entry.label, ok: true, status: "dry-run", action: "install", message: `would run ${entry.command} ${entry.args.join(" ")}` };
  }
  opts.onProgress?.(`${entry.label}: ${entry.command} ${entry.args.join(" ")}`);
  const run = await runCommand(entry.commandForPlatform || entry.command, entry.args, {
    cwd: entry.root,
    timeoutMs: opts.timeoutMs,
    onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
  });
  if (!run.ok) return { present: true, root: entry.root, label: entry.label, ok: false, status: "failed", action: "install", message: `${entry.command} failed: ${firstLine(run.message)}` };
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, `${new Date().toISOString()}\n`, "utf8");
  return { present: true, root: entry.root, label: entry.label, ok: true, status: "installed", action: "install", message: `${entry.command} completed` };
}

async function ensureJinaModel(entry, opts) {
  const inspect = opts.inspectJinaModel || inspectJinaModelDefault;
  const pull = opts.pullJinaModel || pullJinaModelDefault;
  const before = inspect(entry.root);
  const base = {
    present: true,
    root: entry.root,
    label: entry.label,
    model: "jina-v2-code",
    version: before.packageVersion || null,
    model_cache_dir: before.modelCacheDir,
    package_manifest: before.packageManifestPath,
  };
  if (before.ready) {
    return { ...base, ok: true, status: "ok", action: "none", message: `Jina ${before.packageVersion} ready` };
  }
  if (opts.dryRun) {
    return {
      ...base,
      ok: true,
      status: "dry-run",
      action: "download",
      reason: before.reason,
      message: "would download and deploy the current Jina code-embedding model",
    };
  }

  opts.onProgress?.(`${entry.label}: resolving current package`);
  try {
    const pulled = await pull({
      repoRoot: entry.root,
      manager: opts.jinaModelManager,
      timeoutMs: opts.modelTimeoutMs,
      onProgress: (event) => {
        const status = String(event?.status || "working");
        opts.onProgress?.(`${entry.label}: ${status}`);
      },
    });
    const after = pulled?.ready ? pulled : inspect(entry.root);
    return {
      ...base,
      ...after,
      version: after.packageVersion || pulled?.downloaded?.version || null,
      ok: after.ready === true,
      status: after.ready === true ? "installed" : "failed",
      action: "download",
      message: after.ready === true
        ? `Jina ${after.packageVersion || pulled?.downloaded?.version || "model"} downloaded and deployed`
        : `Jina deployment incomplete: ${after.reason || "model verification failed"}`,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      status: "failed",
      action: "download",
      reason: before.reason,
      message: `Jina download/deploy failed: ${firstLine(err?.message || err) || "unknown error"}`,
    };
  }
}

async function ensureDependencyEntry(entry, ensure, opts) {
  try {
    return await withDependencyInstallLock(opts.posseRoot, () => ensure(entry, opts), {
      dryRun: opts.dryRun,
      waitMs: opts.timeoutMs,
      onProgress: (message) => opts.onProgress?.(`${entry.label}: ${message}`),
    });
  } catch (err) {
    return {
      present: true,
      root: entry.root,
      label: entry.label,
      ok: false,
      status: "failed",
      action: "install",
      message: firstLine(err?.message || err) || "dependency repair failed",
    };
  }
}

/**
 * Repair only Posse's own Node dependency tree for callers that already loaded
 * the full dependency-sync graph. The top-level Windows maintenance bootstrap
 * uses the deliberately lightweight posse-node-repair.js worker instead.
 *
 * @param {{
 *   posseRoot?: string,
 *   dryRun?: boolean,
 *   forceNodeInstall?: boolean,
 *   adoptNodeInstall?: boolean,
 *   timeoutMs?: number | string | boolean | null,
 *   onProgress?: ((message: string) => void) | null,
 * }} [input]
 */
export async function ensurePosseNodeDependencies(input = {}) {
  const posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
  const opts = {
    dryRun: input.dryRun === true,
    posseRoot,
    projectDir: posseRoot,
    forceNodeInstall: input.forceNodeInstall === true,
    adoptNodeInstall: input.adoptNodeInstall === true,
    timeoutMs: normalizeCommandTimeoutMs(input.timeoutMs, DEFAULT_DOCTOR_COMMAND_TIMEOUT_MS),
    onProgress: typeof input.onProgress === "function" ? input.onProgress : null,
  };
  return await ensureDependencyEntry(
    { root: posseRoot, label: "posse npm" },
    ensureNodeProject,
    opts,
  );
}

// Registered/approved test runners for the toolchain languages doctor cannot
// install itself. Detection of these languages without a working runner is a
// hard doctor failure — otherwise agents spin out trying to run tests.
const LANGUAGE_TEST_TOOLCHAINS = Object.freeze({
  go: Object.freeze({
    probe: ["go", "version"],
    runner: "go test",
    hint: "install Go (https://go.dev/dl) so `go test` can run",
  }),
  rust: Object.freeze({
    probe: ["cargo", "--version"],
    runner: "cargo test",
    hint: "install Rust via rustup (https://rustup.rs) so `cargo test` can run",
  }),
  php: Object.freeze({
    probe: ["php", "--version"],
    runner: "php tests",
    hint: "install PHP so repository tests (phpunit/composer test) can run",
  }),
});

function probeCommandOk(command, args) {
  try {
    const spec = commandSpawnSpec(command, args, { env: process.env });
    const result = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
      timeout: 15000,
    });
    return (result.status ?? 1) === 0;
  } catch {
    return false;
  }
}

function languageTestToolchainEntries(detectedLanguages) {
  const out = [];
  for (const language of detectedLanguages || []) {
    const spec = LANGUAGE_TEST_TOOLCHAINS[language];
    if (!spec) continue;
    const ok = probeCommandOk(spec.probe[0], spec.probe.slice(1));
    out.push({
      language,
      runner: spec.runner,
      ok,
      status: ok ? "ok" : "failed",
      message: ok ? `${spec.runner} available` : `${spec.runner} unavailable: ${spec.hint}`,
    });
  }
  return out;
}

function testToolRuntime(projectRoot, posseRoot, {
  requirePython = false,
  assumeRepoPython = false,
  detectedLanguages = null,
  dryRun = false,
} = {}) {
  const requirePythonRuntime = requirePython || assumeRepoPython;
  const managedPython = requirePythonRuntime
    ? inspectPythonProject(projectRoot, { posseRoot, assumePython: assumeRepoPython })
    : null;
  const python = !requirePythonRuntime
    ? null
    : (managedPython.present && managedPython.ok
      ? { command: managedPython.python, args: [] }
      : resolvePythonCommand(posseRoot || projectRoot));
  // Plan mode: the pending python-environment install repairs both a missing
  // interpreter (managed CPython download) and missing pytest, so neither
  // should fail the plan.
  const pendingPythonRepair = dryRun && managedPython?.present && !managedPython.ok;
  // pytest is only a requirement when the project repo itself is a python
  // project. requirePython alone can be true just because the posse root
  // ships helper requirements — a JS-only repo must not fail on system
  // python lacking pytest (nothing ever installs it there).
  const repoNeedsPytest = managedPython?.present === true;
  let pytest = null;
  if (repoNeedsPytest) {
    if (python && probeCommandOk(python.command, [...python.args, "-m", "pytest", "--version"])) {
      pytest = { ok: true, message: "python -m pytest available" };
    } else if (pendingPythonRepair) {
      pytest = { ok: true, message: "pytest will be installed into the managed Python runtime" };
    } else {
      pytest = { ok: false, message: "python -m pytest is not runnable; posse doctor installs it into the managed Python runtime" };
    }
  }
  const languages = languageTestToolchainEntries(detectedLanguages);
  const pythonOk = !requirePythonRuntime
    || pendingPythonRepair
    || Boolean(python && (!repoNeedsPytest || pytest?.ok));
  return {
    ok: Boolean(process.execPath) && pythonOk && languages.every((entry) => entry.ok),
    javascript: { ok: Boolean(process.execPath), command: process.execPath },
    python: {
      ok: pythonOk,
      required: requirePythonRuntime,
      command: python?.command || null,
      args: python?.args || [],
      pytest,
    },
    languages,
  };
}

function testToolEntries(test_tools) {
  if (!test_tools || test_tools.skipped) return [];
  return [
    ...(test_tools.javascript ? [{
      present: true,
      label: "test javascript",
      ok: test_tools.javascript.ok,
      status: test_tools.javascript.ok ? "ok" : "failed",
      message: test_tools.javascript.command || "node unavailable",
    }] : []),
    ...(test_tools.python?.required ? [{
      present: true,
      label: "test python",
      ok: test_tools.python.ok,
      status: test_tools.python.ok ? "ok" : "failed",
      message: [
        test_tools.python.command || "python unavailable",
        test_tools.python.pytest?.message || "",
      ].filter(Boolean).join("; "),
    }] : []),
    ...(Array.isArray(test_tools.languages) ? test_tools.languages.map((entry) => ({
      present: true,
      label: `test ${entry.language}`,
      ok: entry.ok,
      status: entry.status,
      message: entry.message,
    })) : []),
  ];
}

function scipModeEnabled(value) {
  return String(value || "on").trim().toLowerCase() !== "off";
}

function neededScipLanguages({ projectDir, posseRoot, languages }) {
  try {
    const lookup = resolveScipStagePlans({
      repoRoot: projectDir,
      posseRoot,
      languages,
    });
    const needed = new Set();
    for (const candidate of lookup.candidates || []) {
      if (candidate?.id && candidate.id !== "configured") needed.add(candidate.id);
    }
    for (const plan of lookup.plans || []) {
      if (plan?.indexerId && plan.indexerId !== "configured") needed.add(plan.indexerId);
    }
    return [...needed];
  } catch {
    return null;
  }
}

function summarizeResults(results) {
  const present = results.filter((entry) => entry?.present !== false && entry?.status !== "skipped");
  return {
    checked: present.length,
    installed: present.filter((entry) => entry.status === "installed").length,
    dry_run: present.filter((entry) => entry.status === "dry-run").length,
    failed: present.filter((entry) => entry.status === "failed" || entry.ok === false).length,
    ready: present.filter((entry) => entry.status === "ok").length,
  };
}

function bootDependencyEntries(result) {
  if (!result) return [];
  return [
    ...(Array.isArray(result.node) ? result.node : []),
    ...(Array.isArray(result.python) ? result.python : []),
    ...(Array.isArray(result.composer) ? result.composer : []),
    ...(Array.isArray(result.native) ? result.native : []),
    ...(Array.isArray(result.models) ? result.models : []),
    ...(Array.isArray(result.scip?.results) ? result.scip.results.map((entry) => ({
      ...entry,
      present: true,
      label: `scip ${entry.language}`,
    })) : []),
    ...testToolEntries(result.test_tools),
  ].filter((entry) => entry?.present !== false && entry?.status !== "skipped");
}

function buildDependencyDoctorReport(result, mode) {
  const entries = bootDependencyEntries(result);
  const failed = entries.filter((entry) => entry?.status === "failed" || entry?.ok === false);
  const pending = entries.filter((entry) => entry?.status === "dry-run" || entry?.status === "needs-install");
  const repaired = entries.filter((entry) => entry?.status === "installed");
  const ready = entries.filter((entry) => entry?.status === "ok");
  return {
    ok: failed.length === 0,
    mode,
    summary: formatBootDependencySync(result),
    checked: entries.length,
    repaired,
    pending,
    failed,
    ready,
  };
}

/**
 * Sync boot dependencies to local manifests. The default is repair mode;
 * tests and diagnostics can pass dryRun=true to get the install plan without
 * running package managers.
 *
 * @param {{
 *   projectDir?: string,
 *   posseRoot?: string,
 *   scipLanguages?: string[] | string | null,
 *   scipMode?: string | null,
 *   dryRun?: boolean,
 *   includeNode?: boolean,
 *   includePython?: boolean,
 *   includeComposer?: boolean,
 *   includeGo?: boolean,
 *   includeCargo?: boolean,
 *   includeNativeBinaries?: boolean,
 *   includeJinaModel?: boolean,
 *   includeScip?: boolean,
 *   includeTestTools?: boolean,
 *   timeoutMs?: number | string | boolean | null,
 *   modelTimeoutMs?: number | string | boolean | null,
 *   forceNodeInstall?: boolean,
 *   adoptNodeInstall?: boolean,
 *   onProgress?: ((message: string) => void) | null,
 *   onEvent?: ((event: Record<string, any>) => void) | null,
 *   nativeBinaryManager?: any,
 *   jinaModelManager?: any,
 *   inspectJinaModel?: typeof inspectJinaModelDefault,
 *   pullJinaModel?: typeof pullJinaModelDefault,
 * }} [input]
 */
export async function ensureBootDependencies(input = {}) {
  const projectDir = path.resolve(String(input.projectDir || process.cwd()));
  const posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
  const dryRun = input.dryRun === true;
  const opts = {
    dryRun,
    posseRoot,
    projectDir,
    forceNodeInstall: input.forceNodeInstall === true,
    adoptNodeInstall: input.adoptNodeInstall === true,
    timeoutMs: normalizeCommandTimeoutMs(input.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    modelTimeoutMs: normalizeCommandTimeoutMs(input.modelTimeoutMs, DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS),
    onProgress: typeof input.onProgress === "function" ? input.onProgress : null,
    onEvent: typeof input.onEvent === "function" ? input.onEvent : null,
    jinaModelManager: input.jinaModelManager || input.nativeBinaryManager || nativeBinaries,
    inspectJinaModel: input.inspectJinaModel || inspectJinaModelDefault,
    pullJinaModel: input.pullJinaModel || pullJinaModelDefault,
  };

  /** @type {any[]} */
  const node = [];
  /** @type {any[]} */
  const python = [];
  /** @type {any[]} */
  const composer = [];
  /** @type {any[]} */
  const native = [];
  /** @type {any[]} */
  const models = [];
  /** @type {{ ok: boolean, skipped?: string, results: any[] }} */
  let scip = { ok: true, skipped: "disabled", results: [] };
  const includeNode = input.includeNode !== false;
  const includePython = input.includePython !== false;
  const includeComposer = input.includeComposer !== false;
  const includeGo = input.includeGo !== false;
  const includeCargo = input.includeCargo !== false;
  const includeNativeBinaries = input.includeNativeBinaries === true;
  const includeJinaModel = input.includeJinaModel === true;
  const includeScip = input.includeScip !== false;
  const includeTestTools = input.includeTestTools !== false;

  // Detect the repo's enabled SCIP/source languages once: the SCIP installer,
  // the python-environment step, and the test-toolchain checks all key off it.
  const scipEnabled = scipModeEnabled(input.scipMode);
  const neededLanguages = scipEnabled && (includeScip || includeTestTools || includePython)
    ? neededScipLanguages({ projectDir, posseRoot, languages: input.scipLanguages })
    : null;
  const pythonLanguageEnabled = Boolean(neededLanguages?.includes("python"));

  if (includeNode) {
    const nodeRoots = uniqueByPath([
      { root: posseRoot, label: "posse npm" },
      { root: projectDir, label: "repo npm" },
      ...discoverLockBackedNodeRoots(projectDir),
    ]).filter((entry) => fileExists(path.join(entry.root, "package.json")));
    for (const entry of nodeRoots) node.push(await ensureDependencyEntry(entry, ensureNodeProject, opts));
  }

  if (includePython) {
    // A repo qualifies when it carries any Python project manifest, or when
    // the enabled SCIP environments detected python sources at all (so a
    // marker-less python repo still gets an interpreter + pytest).
    const pythonRoots = uniqueByPath([
      { root: posseRoot, label: "posse python" },
      { root: projectDir, label: "repo python", assumePython: pythonLanguageEnabled },
    ]).filter((entry) => entry.assumePython || listPythonProjectManifests(entry.root).length > 0);
    for (const entry of pythonRoots) python.push(await ensureDependencyEntry(entry, ensurePythonProject, opts));
  }

  if (includeComposer) {
    const composerRoots = uniqueByPath([
      { root: projectDir, label: "repo composer" },
    ]).filter((entry) => fileExists(path.join(entry.root, "composer.json")));
    for (const entry of composerRoots) composer.push(await ensureDependencyEntry(entry, ensureComposerProject, opts));
  }

  if (includeGo) {
    native.push(await ensureDependencyEntry({
      root: projectDir,
      label: "repo go modules",
      manifest: "go.mod",
      stamp: path.join(".posse", "deps", "go-mod-download.stamp"),
      command: "go",
      args: ["mod", "download"],
    }, ensureSimpleCommandProject, opts));
  }

  if (includeCargo) {
    native.push(await ensureDependencyEntry({
      root: projectDir,
      label: "repo cargo",
      manifest: "Cargo.toml",
      stamp: path.join(".posse", "deps", "cargo-fetch.stamp"),
      command: "cargo",
      args: ["fetch"],
    }, ensureSimpleCommandProject, opts));
  }

  if (includeNativeBinaries) {
    native.push(...await reconcileNativeBinaries({
      manager: input.nativeBinaryManager || nativeBinaries,
      refresh: true,
      dryRun,
      onProgress: opts.onProgress,
    }));
  }

  if (includeJinaModel) {
    models.push(await ensureDependencyEntry({
      root: projectDir,
      label: "model jina",
    }, ensureJinaModel, opts));
  }

  if (includeScip) {
    if (scipEnabled) {
      const scipLanguages = neededLanguages;
      if (scipLanguages && scipLanguages.length === 0) {
        scip = { ok: true, skipped: "no SCIP source languages detected", results: [] };
      } else {
        opts.onProgress?.("SCIP deps: checking managed indexers");
        try {
          scip = await installScipLanguageDependencies({
            posseRoot,
            languages: scipLanguages || input.scipLanguages,
            dryRun,
            timeoutMs: opts.timeoutMs,
            onProgress: (message) => opts.onProgress?.(prefixScipDependencyProgress(message)),
            onEvent: (event) => opts.onEvent?.(event),
          });
        } catch (err) {
          scip = {
            ok: false,
            results: [{ language: "environment", ok: false, status: "failed", message: err?.message || String(err) }],
          };
        }
      }
    } else {
      scip = { ok: true, skipped: "scip disabled", results: [] };
    }
  }

  const test_tools = includeTestTools
    ? testToolRuntime(projectDir, posseRoot, {
      requirePython: python.some((entry) => entry?.present !== false),
      assumeRepoPython: pythonLanguageEnabled,
      detectedLanguages: neededLanguages,
      dryRun,
    })
    : { ok: true, skipped: "disabled" };
  const allResults = [
    ...node,
    ...python,
    ...composer,
    ...native.filter((entry) => entry?.present !== false),
    ...models,
    ...(Array.isArray(scip.results) ? scip.results.map((entry) => ({
      ...entry,
      present: true,
      label: `scip ${entry.language}`,
    })) : []),
    ...(includeTestTools ? testToolEntries(test_tools) : []),
  ];
  const counts = summarizeResults(allResults);
  const ok = counts.failed === 0;
  return {
    ok,
    status: ok ? (counts.installed > 0 ? "installed" : counts.dry_run > 0 ? "dry-run" : "ok") : "failed",
    project_dir: projectDir,
    posse_root: posseRoot,
    dry_run: dryRun,
    counts,
    node,
    python,
    composer,
    native: native.filter((entry) => entry?.present !== false),
    models,
    scip,
    test_tools,
  };
}

/**
 * Doctor the current repository's dependency/runtime requirements. This uses
 * the same repair engine as boot sync, but returns an explicit doctor report
 * that callers can surface after a runtime/tooling failure.
 *
 * @param {Parameters<typeof ensureBootDependencies>[0]} [input]
 */
export async function doctorRepoDependencies(input = {}) {
  const result = await ensureBootDependencies({
    ...input,
    projectDir: input.projectDir || process.cwd(),
    dryRun: input.dryRun === true,
    includeNativeBinaries: input.includeNativeBinaries !== false,
    includeJinaModel: Object.hasOwn(input, "includeJinaModel")
      ? input.includeJinaModel === true
      : input.includeNativeBinaries !== false,
    timeoutMs: Object.hasOwn(input, "timeoutMs") ? input.timeoutMs : DEFAULT_DOCTOR_COMMAND_TIMEOUT_MS,
    modelTimeoutMs: Object.hasOwn(input, "modelTimeoutMs")
      ? input.modelTimeoutMs
      : DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS,
  });
  const mode = result.dry_run ? "plan" : "repair";
  return {
    ...result,
    doctor: buildDependencyDoctorReport(result, mode),
  };
}

export function ensureBootDependenciesInWorker(input = {}, {
  timeoutMs = 20 * 60 * 1000,
  signal = null,
  onProgress = null,
} = {}) {
  return DEPENDENCY_SYNC_THREAD_MANAGER.run(DEPENDENCY_SYNC_WORKER_URL, {
    label: "Boot dependency sync",
    timeoutMs,
    signal,
    workerData: input,
    onProgress,
  });
}

export function doctorRepoDependenciesInWorker(input = {}, {
  timeoutMs = null,
  signal = null,
  onProgress = null,
} = {}) {
  return DEPENDENCY_SYNC_THREAD_MANAGER.run(DEPENDENCY_SYNC_WORKER_URL, {
    label: "Dependency doctor",
    timeoutMs,
    signal,
    workerData: { ...(input || {}), doctor: true },
    onProgress,
  });
}

export function formatBootDependencySync(result) {
  const counts = result?.counts || {};
  if (!result) return "dependency sync unavailable";
  const entries = bootDependencyEntries(result);
  if (counts.failed > 0) {
    const failed = entries
      .filter((entry) => entry?.status === "failed" || entry?.ok === false)
      .slice(0, 3)
      .map((entry) => `${entry.label || "dependency"}: ${firstLine(entry.message || entry.reason || entry.status)}`)
      .filter(Boolean);
    const suffix = failed.length > 0 ? `: ${failed.join("; ")}` : "";
    const more = counts.failed > failed.length ? ` (+${counts.failed - failed.length} more)` : "";
    return compact(`${counts.failed} failed${counts.installed ? `, ${counts.installed} installed` : ""}${suffix}${more}`, 260);
  }
  if (counts.dry_run > 0) {
    const pending = entries
      .filter((entry) => entry?.status === "dry-run" || entry?.status === "needs-install")
      .slice(0, 3)
      .map((entry) => {
        const label = entry.label || "dependency";
        const detail = firstLine(entry.message || entry.reason || "");
        return detail ? `${label}: ${detail}` : label;
      })
      .filter(Boolean);
    const suffix = pending.length > 0 ? `: ${pending.join("; ")}` : "";
    const more = counts.dry_run > pending.length ? ` (+${counts.dry_run - pending.length} more)` : "";
    return compact(`would install ${counts.dry_run}${suffix}${more}`, 260);
  }
  if (counts.installed > 0) return `installed ${counts.installed}`;
  return "ready";
}
