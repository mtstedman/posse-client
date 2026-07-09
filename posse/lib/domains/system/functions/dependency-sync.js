// @ts-check
//
// Boot-time dependency repair. This keeps startup honest by syncing local
// package environments to checked-in manifests before workers start using
// SCIP, registered tests, or repo-local toolchains.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { gitExec } from "../../git/functions/utils.js";
import { installScipLanguageDependencies } from "../../atlas/functions/v2/scip/dependencies.js";
import { resolveScipStagePlans } from "../../atlas/functions/v2/scip/indexers.js";
import {
  DEFAULT_POSSE_ROOT,
  resolveManagedPythonRuntimeForProject,
} from "../../runtime/functions/python-runtime.js";

const DEPENDENCY_SYNC_WORKER_URL = new URL("./dependency-sync-worker.js", import.meta.url);
const DEPENDENCY_SYNC_THREAD_MANAGER = new ThreadManager();

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_FORCE_KILL_GRACE_MS = 1000;
const COMMAND_TIMEOUT_SETTLE_GRACE_MS = 1000;
const NODE_MANIFEST_STAMP_NAME = ".posse-manifest.sha256";
const COMPOSER_MANIFEST_STAMP_NAME = ".posse-manifest.sha256";
const UNBOUNDED_TIMEOUT_VALUES = new Set(["", "0", "false", "none", "off", "unbounded", "unlimited", "infinite"]);
const DEPENDENCY_INSTALL_ENV_ALLOWLIST = new Set([
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
  "node_extra_ca_certs",
  "no_proxy",
  "npm_config_cafile",
  "npm_config_registry",
  "npm_config_strict_ssl",
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
]);
const DEPENDENCY_INSTALL_URL_ENV_KEYS = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "npm_config_registry",
]);

/**
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function dependencyInstallEnv(sourceEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    const normalizedKey = String(key).toLowerCase();
    if (!DEPENDENCY_INSTALL_ENV_ALLOWLIST.has(normalizedKey)) continue;
    if (value == null) continue;
    let nextValue = String(value);
    if (DEPENDENCY_INSTALL_URL_ENV_KEYS.has(normalizedKey)) {
      nextValue = stripUrlCredentials(nextValue);
      if (!nextValue) continue;
    }
    env[key] = nextValue;
  }
  return env;
}

function stripUrlCredentials(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    return raw.includes("@") ? "" : raw;
  }
  if (!url.username && !url.password && !url.search && !url.hash) return raw;
  // Authenticated proxies may require external configuration; dependency
  // installers intentionally receive URL hosts without embedded credentials.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
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
    if (!root || seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
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
  const base = manager === "pnpm" ? "pnpm"
    : manager === "yarn" ? "yarn"
      : manager === "bun" ? "bun"
        : "npm";
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function nodeInstallCacheDir(root, opts = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const projectRoot = path.resolve(opts.projectDir || resolvedRoot);
  const relToProject = path.relative(projectRoot, resolvedRoot);
  const rootUnderProject = !relToProject || (!relToProject.startsWith("..") && !path.isAbsolute(relToProject));
  const baseRoot = rootUnderProject ? projectRoot : resolvedRoot;
  const key = hashText(resolvedRoot.toLowerCase()).slice(0, 12);
  return path.join(baseRoot, ".posse", "deps", "npm-cache", key);
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

function windowsCommandArg(value) {
  const text = String(value ?? "");
  if (text === "") return "\"\"";
  if (!/[ \t\r\n"&|<>^%!]/u.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/gu, "^$1").replace(/%/gu, "%%")}"`;
}

function spawnSpecForCommand(command, args = []) {
  if (process.platform === "win32" && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [command, ...args].map(windowsCommandArg).join(" ")],
    };
  }
  return { command, args };
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
  const missingNodeModules = !dirExists(nodeModules);
  const manifestHash = nodeManifestHash(root);
  const installedManifestHash = readNodeManifestStamp(root);
  const stale = Boolean(installedManifestHash && manifestHash && installedManifestHash !== manifestHash);
  const needsStamp = Boolean(!missingNodeModules && manifestHash && !installedManifestHash);
  const needsInstall = missingNodeModules
    || missingRequired.length > 0
    || stale
    || (missingOptional.length > 0 && !installedManifestHash);

  return {
    present: true,
    root,
    ok: missingRequired.length === 0,
    status: needsInstall ? "needs-install" : "ok",
    manager,
    missing_node_modules: missingNodeModules,
    missing_required: missingRequired,
    missing_optional: missingOptional,
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

function ensureGeneratedDirectoryIgnored(root, dirName, opts = {}) {
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

  appendGitignorePattern(ignorePath, pattern);
  opts.onProgress?.(`ignored generated dependency directory ${pattern}`);
  return { path: ignorePath, pattern };
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
  if (value === null || value === false) return null;
  if (typeof value === "string" && UNBOUNDED_TIMEOUT_VALUES.has(value.trim().toLowerCase())) return null;
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
    const spawnSpec = spawnSpecForCommand(command, args);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(result);
    };
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env: dependencyInstallEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({ ok: false, message: err?.message || String(err), stdout: "", stderr: "" });
      return;
    }

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
  if (before.status === "ok") {
    if (!opts.dryRun && before.needs_stamp) writeNodeManifestStamp(entry.root, before.manifest_hash);
    return { ...before, label: entry.label, action: before.needs_stamp ? "stamp" : "none", message: "node packages ready" };
  }
  const reason = [
    before.missing_node_modules ? "missing node_modules" : "",
    before.missing_required.length ? `${before.missing_required.length} required missing` : "",
    before.missing_optional.length ? `${before.missing_optional.length} optional missing` : "",
    before.stale ? "manifest newer than install" : "",
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
  const generatedIgnore = before.missing_node_modules
    ? ensureGeneratedDirectoryIgnored(entry.root, "node_modules", opts)
    : null;
  let usedPeerConflictRetry = false;
  if (!run.ok) {
    const peerRetryArgs = installArgsForPeerConflictRetry(before.manager, args, run);
    if (!peerRetryArgs) {
      return { ...before, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `${installLabel} failed: ${firstLine(run.message)}` };
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
        message: `${installLabel} failed after peer dependency retry: ${firstLine(peerRetry.message) || firstLine(run.message)}`,
      };
    }
    usedPeerConflictRetry = true;
  }
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
      if (missingRequiredNodePackageLabels(after).length === 0) {
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
      return { ...after, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `${before.manager} focused install failed: ${firstLine(retry.message)}` };
    }
    after = inspectNodeProject(entry.root);
    missingAfter = missingNodePackageLabels(after);
    usedFocusedRetry = true;
  }
  const missingRequiredAfter = missingRequiredNodePackageLabels(after);
  const missingOptionalAfter = missingOptionalNodePackageLabels(after);
  const packagesOk = missingRequiredAfter.length === 0;
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
      : `missing required packages after install: ${missingRequiredAfter.join(", ")}`,
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
  candidates.push(
    { command: "python", args: [] },
    { command: "python3", args: [] },
    { command: "py", args: ["-3"] },
  );
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
  });
  if (!runtime) {
    return { present: false, root, ok: true, status: "skipped", reason: "no requirements.txt" };
  }
  return {
    present: true,
    root,
    ok: runtime.ready,
    status: runtime.ready ? "ok" : "needs-install",
    requirements: runtime.requirements,
    requirements_hash: runtime.requirementsHash,
    python: runtime.python,
    stamp_path: runtime.stampPath,
    runtime_dir: runtime.runtimeDir,
    runtime_bin_dir: runtime.binDir,
  };
}

async function ensurePythonProject(entry, opts) {
  const before = inspectPythonProject(entry.root, opts);
  if (!before.present) return before;
  if (before.status === "ok") return { ...before, label: entry.label, action: "none", message: "python requirements ready" };
  const basePython = resolvePythonCommand(opts.posseRoot);
  if (!basePython) {
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: "Python is not available on PATH" };
  }
  if (opts.dryRun) {
    return { ...before, label: entry.label, ok: true, status: "dry-run", action: "install", message: `would create Posse-managed Python runtime and pip install -r ${path.basename(before.requirements)}` };
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
  const pip = await runCommand(before.python, ["-m", "pip", "install", "-r", before.requirements], {
    cwd: entry.root,
    timeoutMs: opts.timeoutMs,
    onProgress: (line) => opts.onProgress?.(`${entry.label}: ${line}`),
  });
  if (!pip.ok) {
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", message: `pip install failed: ${firstLine(pip.message)}` };
  }
  fs.mkdirSync(path.dirname(before.stamp_path), { recursive: true });
  fs.writeFileSync(before.stamp_path, `${before.requirements_hash}\n`, "utf8");
  const after = inspectPythonProject(entry.root, opts);
  return { ...after, label: entry.label, ok: after.status === "ok", status: after.status === "ok" ? "installed" : "failed", action: "install", message: "python requirements installed" };
}

function composerCommand(posseRoot) {
  const composer = process.platform === "win32" ? "composer.bat" : "composer";
  if (commandOnPath(composer)) return { command: composer, args: [] };
  const phar = path.join(posseRoot, "scip", "bin", "composer.phar");
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
  const needsInstall = missingVendor || missingInstalled || staleByHash || staleByMtime;
  const needsStamp = Boolean(!needsInstall && manifestHash && !installedManifestHash);
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
    if (!opts.dryRun && before.needs_stamp) writeComposerManifestStamp(entry.root, before.manifest_hash);
    return { ...before, label: entry.label, action: before.needs_stamp ? "stamp" : "none", message: "composer dependencies ready" };
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
  const generatedIgnore = before.missing_vendor
    ? ensureGeneratedDirectoryIgnored(entry.root, "vendor", opts)
    : null;
  if (!run.ok) {
    const detail = summarizeComposerFailure(`${run.stderr || ""}\n${run.stdout || ""}\n${run.message || ""}`);
    return { ...before, label: entry.label, ok: false, status: "failed", action: "install", generated_ignore: generatedIgnore, message: `composer install failed: ${detail}` };
  }
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

function testToolRuntime(projectRoot, posseRoot) {
  const managedPython = inspectPythonProject(projectRoot, { posseRoot });
  const python = managedPython.present && managedPython.ok
    ? { command: managedPython.python, args: [] }
    : resolvePythonCommand(posseRoot || projectRoot);
  return {
    ok: Boolean(process.execPath) && Boolean(python),
    javascript: { ok: Boolean(process.execPath), command: process.execPath },
    python: { ok: Boolean(python), command: python?.command || null, args: python?.args || [] },
  };
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
    ...(Array.isArray(result.scip?.results) ? result.scip.results.map((entry) => ({
      ...entry,
      present: true,
      label: `scip ${entry.language}`,
    })) : []),
    ...(result.test_tools?.javascript ? [{
      present: true,
      label: "test javascript",
      ok: result.test_tools.javascript.ok,
      status: result.test_tools.javascript.ok ? "ok" : "failed",
      message: result.test_tools.javascript.command || "node unavailable",
    }] : []),
    ...(result.test_tools?.python ? [{
      present: true,
      label: "test python",
      ok: result.test_tools.python.ok,
      status: result.test_tools.python.ok ? "ok" : "failed",
      message: result.test_tools.python.command || "python unavailable",
    }] : []),
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
 *   includeScip?: boolean,
 *   includeTestTools?: boolean,
 *   timeoutMs?: number | string | boolean | null,
 *   onProgress?: ((message: string) => void) | null,
 *   onEvent?: ((event: Record<string, any>) => void) | null,
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
    timeoutMs: normalizeCommandTimeoutMs(input.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    onProgress: typeof input.onProgress === "function" ? input.onProgress : null,
    onEvent: typeof input.onEvent === "function" ? input.onEvent : null,
  };

  /** @type {any[]} */
  const node = [];
  /** @type {any[]} */
  const python = [];
  /** @type {any[]} */
  const composer = [];
  /** @type {any[]} */
  const native = [];
  /** @type {{ ok: boolean, skipped?: string, results: any[] }} */
  let scip = { ok: true, skipped: "disabled", results: [] };
  const includeNode = input.includeNode !== false;
  const includePython = input.includePython !== false;
  const includeComposer = input.includeComposer !== false;
  const includeGo = input.includeGo !== false;
  const includeCargo = input.includeCargo !== false;
  const includeScip = input.includeScip !== false;
  const includeTestTools = input.includeTestTools !== false;

  if (includeNode) {
    const nodeRoots = uniqueByPath([
      { root: posseRoot, label: "posse npm" },
      { root: projectDir, label: "repo npm" },
      ...discoverLockBackedNodeRoots(projectDir),
    ]).filter((entry) => fileExists(path.join(entry.root, "package.json")));
    for (const entry of nodeRoots) node.push(await ensureNodeProject(entry, opts));
  }

  if (includePython) {
    const pythonRoots = uniqueByPath([
      { root: posseRoot, label: "posse python" },
      { root: projectDir, label: "repo python" },
    ]).filter((entry) => fileExists(path.join(entry.root, "requirements.txt")));
    for (const entry of pythonRoots) python.push(await ensurePythonProject(entry, opts));
  }

  if (includeComposer) {
    const composerRoots = uniqueByPath([
      { root: projectDir, label: "repo composer" },
    ]).filter((entry) => fileExists(path.join(entry.root, "composer.json")));
    for (const entry of composerRoots) composer.push(await ensureComposerProject(entry, opts));
  }

  if (includeGo) {
    native.push(await ensureSimpleCommandProject({
      root: projectDir,
      label: "repo go modules",
      manifest: "go.mod",
      stamp: path.join(".posse", "deps", "go-mod-download.stamp"),
      command: "go",
      args: ["mod", "download"],
    }, opts));
  }

  if (includeCargo) {
    native.push(await ensureSimpleCommandProject({
      root: projectDir,
      label: "repo cargo",
      manifest: "Cargo.toml",
      stamp: path.join(".posse", "deps", "cargo-fetch.stamp"),
      command: "cargo",
      args: ["fetch"],
    }, opts));
  }

  if (includeScip) {
    if (scipModeEnabled(input.scipMode)) {
      const scipLanguages = neededScipLanguages({
        projectDir,
        posseRoot,
        languages: input.scipLanguages,
      });
      if (scipLanguages && scipLanguages.length === 0) {
        scip = { ok: true, skipped: "no SCIP source languages detected", results: [] };
      } else {
        opts.onProgress?.("SCIP deps: checking managed indexers");
        scip = await installScipLanguageDependencies({
          posseRoot,
          languages: scipLanguages || input.scipLanguages,
          dryRun,
          timeoutMs: opts.timeoutMs,
          onProgress: (message) => opts.onProgress?.(prefixScipDependencyProgress(message)),
          onEvent: (event) => opts.onEvent?.(event),
        });
      }
    } else {
      scip = { ok: true, skipped: "scip disabled", results: [] };
    }
  }

  const test_tools = includeTestTools ? testToolRuntime(projectDir, posseRoot) : { ok: true, skipped: "disabled" };
  const allResults = [
    ...node,
    ...python,
    ...composer,
    ...native.filter((entry) => entry?.present !== false),
    ...(Array.isArray(scip.results) ? scip.results.map((entry) => ({
      ...entry,
      present: true,
      label: `scip ${entry.language}`,
    })) : []),
    ...(includeTestTools ? [
      { present: true, label: "test javascript", ok: test_tools.javascript.ok, status: test_tools.javascript.ok ? "ok" : "failed", message: test_tools.javascript.command || "node unavailable" },
      { present: true, label: "test python", ok: test_tools.python.ok, status: test_tools.python.ok ? "ok" : "failed", message: test_tools.python.command || "python unavailable" },
    ] : []),
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
    timeoutMs: Object.hasOwn(input, "timeoutMs") ? input.timeoutMs : null,
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
