// @ts-check
//
// Posse-managed dependency setup for SCIP indexer languages. The admin TUI
// calls this after saving the language selector; operators can also invoke it
// through `posse atlas-v2 scip install`.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { normalizeScipLanguages } from "./languages.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POSSE_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..", "..", "..");
const DEFAULT_SCIP_COMMAND_TIMEOUT_MS = 600_000;
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
]);

/**
 * @typedef {{
 *   language: string,
 *   ok: boolean,
 *   status: "ok" | "installed" | "dry-run" | "skipped" | "failed",
 *   message: string,
 * }} ScipLanguageInstallResult
 */

/**
 * @param {{
 *   languages?: string[] | string | null,
 *   posseRoot?: string | null,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   timeoutMs?: number | string | boolean | null,
 *   onProgress?: ((message: string) => void) | null,
 * }} [input]
 * @returns {{ ok: boolean, languages: string[], results: ScipLanguageInstallResult[] }}
 */
export function installScipLanguageDependenciesSync(input = {}) {
  const posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
  const languages = normalizeScipLanguages(input.languages);
  const force = input.force === true;
  const dryRun = input.dryRun === true;
  const timeoutMs = normalizeCommandTimeoutMs(input.timeoutMs, DEFAULT_SCIP_COMMAND_TIMEOUT_MS);
  const onProgress = typeof input.onProgress === "function" ? input.onProgress : null;
  /** @type {ScipLanguageInstallResult[]} */
  const results = [];

  const nodeLanguages = languages.filter((language) => language === "typescript" || language === "python");
  if (nodeLanguages.length > 0) {
    const nodeResult = installNodeScipDeps({ posseRoot, languages: nodeLanguages, force, dryRun, timeoutMs, onProgress });
    for (const language of nodeLanguages) {
      results.push({ ...nodeResult, language });
    }
  }
  if (languages.includes("php")) {
    results.push(installPhpScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }));
  }
  if (languages.includes("go")) {
    results.push(installGoScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }));
  }
  if (languages.includes("rust")) {
    results.push(installRustScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }));
  }
  if (languages.includes("clang")) {
    results.push(installClangScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }));
  }

  return {
    ok: results.every((result) => result.ok),
    languages,
    results,
  };
}

/**
 * @param {{ languages?: string[] | string | null, posseRoot?: string | null }} [input]
 * @returns {ScipLanguageInstallResult[]}
 */
export function getScipLanguageDependencyStatus(input = {}) {
  const posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
  const languages = normalizeScipLanguages(input.languages);
  return languages.map((language) => {
    if (language === "typescript") return statusForInstalledCommand(posseRoot, language, ["scip", "node", "node_modules", ".bin"], "scip-typescript");
    if (language === "python") return statusForInstalledCommand(posseRoot, language, ["scip", "node", "node_modules", ".bin"], "scip-python");
    if (language === "php") return statusForInstalledCommand(posseRoot, language, ["scip", "php", "vendor", "bin"], "scip-php");
    if (language === "go") return statusForInstalledCommand(posseRoot, language, ["scip", "bin"], "scip-go");
    if (language === "rust") return statusForInstalledCommand(posseRoot, language, ["scip", "bin"], "scip-rust");
    if (language === "clang") return clangScipStatus(posseRoot);
    return { language, ok: false, status: "failed", message: "unknown SCIP language" };
  });
}

function installNodeScipDeps({ posseRoot, languages, force, dryRun, timeoutMs, onProgress }) {
  const nodeDir = path.join(posseRoot, "scip", "node");
  const packageJson = path.join(nodeDir, "package.json");
  if (!fs.existsSync(packageJson)) {
    return failed("node", `missing ${packageJson}`);
  }
  const missing = languages.filter((language) => !findCommandPath(
    posseRoot,
    ["scip", "node", "node_modules", ".bin"],
    nodeCommandForLanguage(language),
  ));
  if (!force && missing.length === 0) {
    const validation = validateNodeScipCommands(posseRoot, languages);
    if (!validation.ok) return failed("node", validation.message);
    return ok("node", "ok", "SCIP Node indexers already installed");
  }
  if (dryRun) {
    return ok("node", "dry-run", `would run npm install in ${nodeDir}`);
  }
  emit(onProgress, `installing Node SCIP indexers for ${languages.join(", ")}`);
  const run = runCommand(npmCommand(), ["install"], { cwd: nodeDir, timeoutMs });
  if (!run.ok) return failed("node", `npm install failed: ${run.message}`);
  const validation = validateNodeScipCommands(posseRoot, languages);
  if (!validation.ok) return failed("node", validation.message);
  return ok("node", "installed", "installed SCIP Node indexers");
}

function installPhpScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }) {
  const phpDir = path.join(posseRoot, "scip", "php");
  const composerJson = path.join(phpDir, "composer.json");
  const scipPhp = findCommandPath(posseRoot, ["scip", "php", "vendor", "bin"], "scip-php");
  if (!fs.existsSync(composerJson)) return failed("php", `missing ${composerJson}`);
  if (!force && scipPhp) return ok("php", "ok", "scip-php already installed");
  if (dryRun) {
    return ok("php", "dry-run", `would run composer install in ${phpDir}`);
  }
  const composer = composerCommand(posseRoot);
  if (!composer) {
    return failed("php", "PHP/Composer not found; install PHP CLI or composer, then retry");
  }
  emit(onProgress, "installing PHP SCIP indexer");
  const run = runCommand(composer.command, [...composer.args, "install"], { cwd: phpDir, timeoutMs });
  if (!run.ok) return failed("php", `composer install failed: ${run.message}`);
  if (!findCommandPath(posseRoot, ["scip", "php", "vendor", "bin"], "scip-php")) {
    return failed("php", "composer install completed, but scip-php was not found");
  }
  return ok("php", "installed", "installed scip-php");
}

function installGoScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }) {
  const binDir = path.join(posseRoot, "scip", "bin");
  const scipGo = findCommandPath(posseRoot, ["scip", "bin"], "scip-go");
  if (!force && scipGo) return ok("go", "ok", "scip-go already installed");
  if (dryRun) {
    return ok("go", "dry-run", `would run go install github.com/scip-code/scip-go/cmd/scip-go@latest with GOBIN=${binDir}`);
  }
  if (!commandOnPath("go")) return failed("go", "Go toolchain not found on PATH; install Go or deselect Go in atlas_scip_languages");
  fs.mkdirSync(binDir, { recursive: true });
  emit(onProgress, "installing Go SCIP indexer");
  const run = runCommand("go", ["install", "github.com/scip-code/scip-go/cmd/scip-go@latest"], {
    env: { ...scipDependencyInstallEnv(), GOBIN: binDir },
    timeoutMs,
  });
  if (!run.ok) return failed("go", `go install failed: ${run.message}`);
  if (!findCommandPath(posseRoot, ["scip", "bin"], "scip-go")) {
    return failed("go", "go install completed, but scip-go was not found in Posse scip/bin");
  }
  return ok("go", "installed", "installed scip-go");
}

function installRustScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }) {
  const binDir = path.join(posseRoot, "scip", "bin");
  const wrapper = commandPath(posseRoot, ["scip", "bin"], "scip-rust");
  if (!force && fileExists(wrapper)) {
    const validation = validateRustAnalyzer({ timeoutMs, onProgress });
    if (!validation.ok) return failed("rust", `scip-rust wrapper exists, but ${validation.message}`);
    return ok("rust", "ok", "scip-rust wrapper already installed");
  }
  if (dryRun) return ok("rust", "dry-run", `would install rust-analyzer if needed and write scip-rust wrapper in ${binDir}`);
  const validation = validateRustAnalyzer({ timeoutMs, onProgress });
  if (!validation.ok) return failed("rust", validation.message);
  fs.mkdirSync(binDir, { recursive: true });
  emit(onProgress, "writing Rust SCIP wrapper");
  writeRustWrapper(binDir);
  return ok("rust", "installed", "installed scip-rust wrapper");
}

// Pinned scip-clang release. Upstream publishes single-file binaries per
// release (v0.4.0 ships scip-clang-x86_64-linux and scip-clang-arm64-darwin;
// there is NO Windows build). Bump deliberately — staged .scip output format
// must stay compatible with the ingester.
const SCIP_CLANG_VERSION = "v0.4.0";

function clangReleaseAssetCandidates() {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  // Try both historical naming orders so an upstream rename degrades to a
  // clear failure message instead of a silent wrong-asset 404.
  return [`scip-clang-${arch}-${os}`, `scip-clang-${os}-${arch}`];
}

/**
 * Managed install for scip-clang, mirroring the go/rust flows: a Posse-owned
 * binary in scip/bin. Upstream has no package-manager path, so this is a
 * direct download of the pinned GitHub release via curl (the install env
 * allowlist already carries the proxy/CA variables curl needs).
 *
 * Windows is deliberately a NON-FATAL skip, not a failure: no upstream
 * Windows build exists, and boot hard-stops on failed dependency sync — a
 * hard failure here would brick boots of every C/C++ repo on Windows hosts.
 * The C/C++ SCIP layer simply stays off there (WSL or
 * atlas_scip_index_command are the escape hatches); tree-sitter remains the
 * symbol source.
 */
function installClangScipDeps({ posseRoot, force, dryRun, timeoutMs, onProgress }) {
  const found = findCommandPath(posseRoot, ["scip", "bin"], "scip-clang")
    || (commandOnPath("scip-clang") ? "scip-clang" : null);
  if (process.platform === "win32") {
    if (found) return ok("clang", "ok", "scip-clang already installed");
    return {
      language: "clang",
      ok: true,
      status: "skipped",
      message: "scip-clang has no Windows build; C/C++ SCIP stays off (use WSL or atlas_scip_index_command)",
    };
  }
  if (!force && found) return ok("clang", "ok", "scip-clang already installed");
  const binDir = path.join(posseRoot, "scip", "bin");
  if (dryRun) {
    return ok("clang", "dry-run", `would download scip-clang ${SCIP_CLANG_VERSION} into ${binDir}`);
  }
  if (!commandOnPath("curl")) {
    return failed("clang", "curl not found; install curl or place scip-clang on PATH / in Posse scip/bin");
  }
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, "scip-clang");
  const tmpDest = `${dest}.download`;
  const errors = [];
  for (const asset of clangReleaseAssetCandidates()) {
    const url = `https://github.com/sourcegraph/scip-clang/releases/download/${SCIP_CLANG_VERSION}/${asset}`;
    emit(onProgress, `downloading ${asset} (${SCIP_CLANG_VERSION})`);
    const run = runCommand("curl", ["-fsSL", "--retry", "2", "-o", tmpDest, url], { timeoutMs });
    if (!run.ok) {
      errors.push(`${asset}: ${run.message || "download failed"}`);
      try { fs.rmSync(tmpDest, { force: true }); } catch { /* best effort */ }
      continue;
    }
    fs.renameSync(tmpDest, dest);
    fs.chmodSync(dest, 0o755);
    const probe = runCommand(dest, ["--version"], { timeoutMs: 30_000 });
    if (!probe.ok) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      return failed("clang", `downloaded scip-clang failed its --version probe: ${probe.message}`);
    }
    return ok("clang", "installed", `installed scip-clang ${SCIP_CLANG_VERSION}`);
  }
  return failed(
    "clang",
    `scip-clang ${SCIP_CLANG_VERSION} download failed (${errors.join("; ")}); download manually from https://github.com/sourcegraph/scip-clang/releases into ${binDir}`,
  );
}

function clangScipStatus(posseRoot) {
  const found = findCommandPath(posseRoot, ["scip", "bin"], "scip-clang")
    || (commandOnPath("scip-clang") ? "scip-clang" : null);
  if (found) return ok("clang", "ok", "installed");
  if (process.platform === "win32") {
    return {
      language: "clang",
      ok: true,
      status: "skipped",
      message: "scip-clang has no Windows build (WSL or atlas_scip_index_command)",
    };
  }
  return failed("clang", `missing scip-clang (PATH or ${expectedCommandPath(posseRoot, ["scip", "bin"], "scip-clang")}); posse doctor installs it`);
}

function writeRustWrapper(binDir) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "scip-rust.cmd"),
      [
        "@echo off",
        "rust-analyzer scip %*",
      ].join("\r\n"),
      "utf8",
    );
    return;
  }
  const file = path.join(binDir, "scip-rust");
  fs.writeFileSync(file, "#!/usr/bin/env sh\nexec rust-analyzer scip \"$@\"\n", "utf8");
  fs.chmodSync(file, 0o755);
}

function composerCommand(posseRoot) {
  if (commandOnPath("composer")) return { command: composerBin(), args: [] };
  if (!commandOnPath("php")) return null;
  const phar = path.join(posseRoot, "scip", "bin", "composer.phar");
  if (!fs.existsSync(phar)) return null;
  return { command: "php", args: [phar] };
}

function statusForCommand(language, command) {
  if (fileExists(command)) return ok(language, "ok", "installed");
  return failed(language, `missing ${command}`);
}

function statusForInstalledCommand(posseRoot, language, segments, command) {
  return statusForCommand(
    language,
    findCommandPath(posseRoot, segments, command) || expectedCommandPath(posseRoot, segments, command),
  );
}

function nodeCommandForLanguage(language) {
  return language === "python" ? "scip-python" : "scip-typescript";
}

function validateNodeScipCommands(posseRoot, languages) {
  const failures = [];
  for (const language of languages) {
    const commandName = nodeCommandForLanguage(language);
    const command = findCommandPath(posseRoot, ["scip", "node", "node_modules", ".bin"], commandName);
    if (!command) {
      failures.push(`${language}: missing ${expectedCommandPath(posseRoot, ["scip", "node", "node_modules", ".bin"], commandName)}`);
      continue;
    }
    const probe = runCommand(command, ["--version"], { timeoutMs: 30_000 });
    if (!probe.ok) failures.push(`${language}: ${commandName} validation failed: ${probe.message}`);
  }
  if (failures.length > 0) {
    return { ok: false, message: `SCIP Node indexer validation failed: ${failures.join("; ")}` };
  }
  return { ok: true, message: "" };
}

function validateRustAnalyzer({ timeoutMs, onProgress }) {
  if (!commandOnPath("cargo") || !commandOnPath("rustc")) {
    return { ok: false, message: "Rust toolchain not found on PATH; install Rust or deselect Rust in atlas_scip_languages" };
  }

  let probe = runCommand("rust-analyzer", ["--version"], { timeoutMs: 30_000 });
  if (!probe.ok && commandOnPath("rustup")) {
    emit(onProgress, "installing rust-analyzer component");
    const install = runCommand("rustup", ["component", "add", "rust-analyzer"], { timeoutMs });
    clearCommandOnPathCache("rust-analyzer");
    if (!install.ok) {
      return { ok: false, message: `rustup component add rust-analyzer failed: ${install.message}` };
    }
    probe = runCommand("rust-analyzer", ["--version"], { timeoutMs: 30_000 });
  }
  if (!probe.ok) {
    return { ok: false, message: `rust-analyzer not runnable: ${probe.message}` };
  }
  return { ok: true, message: "" };
}

function ok(language, status, message) {
  return { language, ok: true, status, message };
}

function failed(language, message) {
  return { language, ok: false, status: "failed", message };
}

function emit(onProgress, message) {
  if (typeof onProgress === "function") {
    try { onProgress(message); } catch { /* observational */ }
  }
}

function normalizeCommandTimeoutMs(value, fallback = DEFAULT_SCIP_COMMAND_TIMEOUT_MS) {
  if (value === null || value === false) return null;
  if (typeof value === "string" && UNBOUNDED_TIMEOUT_VALUES.has(value.trim().toLowerCase())) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1000, parsed);
  return fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function scipDependencyInstallEnv(sourceEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value == null) continue;
    if (!SCIP_DEPENDENCY_INSTALL_ENV_ALLOWLIST.has(String(key).toLowerCase())) continue;
    env[key] = String(value);
  }
  return env;
}

function runCommand(command, args, { cwd = undefined, env = scipDependencyInstallEnv(), timeoutMs = DEFAULT_SCIP_COMMAND_TIMEOUT_MS } = {}) {
  const spawnSpec = spawnSpecForCommand(command, args, env);
  const effectiveTimeoutMs = normalizeCommandTimeoutMs(timeoutMs, null);
  /** @type {import("child_process").SpawnSyncOptionsWithStringEncoding} */
  const options = {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  if (effectiveTimeoutMs != null) options.timeout = effectiveTimeoutMs;
  const result = spawnSync(spawnSpec.command, spawnSpec.args, options);
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      message: tail(String(result.stderr || result.stdout || `exit ${result.status}`), 1200).trim(),
    };
  }
  return { ok: true, message: tail(String(result.stdout || ""), 1200).trim() };
}

function spawnSpecForCommand(command, args, env) {
  const resolved = resolveWindowsCommand(command, env);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(String(resolved || ""))) {
    return {
      command: env?.ComSpec || env?.COMSPEC || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", resolved, ...args],
    };
  }
  return { command: resolved, args };
}

function resolveWindowsCommand(command, env) {
  const raw = String(command || "");
  if (process.platform !== "win32") return raw;
  if (!raw || raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw)) return raw;
  try {
    const result = spawnSync("where", [raw], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const first = String(result.stdout || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return first || raw;
  } catch {
    return raw;
  }
}

// Per-process memo: a binary's PATH location does not change mid-run,
// so we only spawn the probe once per name. Without this the SCIP
// indexer discovery path would spawn `where`/`which` 5-7 times per
// staging pass during boot warm.
const _scipCommandOnPathCache = new Map();

function commandOnPath(command, env = scipDependencyInstallEnv()) {
  const cacheKey = `${command}\0${pathEnvValue(env)}`;
  if (_scipCommandOnPathCache.has(cacheKey)) {
    return _scipCommandOnPathCache.get(cacheKey);
  }
  const probe = process.platform === "win32" ? "where" : "which";
  const args = [command];
  const result = spawnSync(probe, args, { env, stdio: "ignore", windowsHide: true });
  const ok = result.status === 0;
  _scipCommandOnPathCache.set(cacheKey, ok);
  return ok;
}

function clearCommandOnPathCache(command) {
  for (const key of _scipCommandOnPathCache.keys()) {
    if (key.startsWith(`${command}\0`)) _scipCommandOnPathCache.delete(key);
  }
}

function pathEnvValue(env = {}) {
  const key = Object.keys(env || {}).find((name) => name.toLowerCase() === "path");
  return key ? String(env[key] || "") : "";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function composerBin() {
  return process.platform === "win32" ? "composer.bat" : "composer";
}

function commandPath(posseRoot, segments, command) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.join(posseRoot, ...segments, `${command}${ext}`);
}

function expectedCommandPath(posseRoot, segments, command) {
  return commandPath(posseRoot, segments, command);
}

function findCommandPath(posseRoot, segments, command) {
  const dir = path.join(posseRoot, ...segments);
  for (const ext of commandExts()) {
    const candidate = path.join(dir, `${command}${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function commandExts() {
  return process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
}

function fileExists(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function tail(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(text.length - max) : text;
}
