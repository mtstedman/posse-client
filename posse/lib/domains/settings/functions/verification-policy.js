// Verification time policy: how long a deterministic verification command may
// run before the orchestration layer stops it, and the identity a receipt
// must carry so a timeout observed under one policy is never reused under
// another.
//
// Resolution order for the wall limit:
//   1. repository setting `verification_wall_timeout_ms` (repo-scoped);
//   2. the built-in default.
// Either value is clamped to the administrator ceiling
// `verification_wall_timeout_max_ms` (account-global), so a repository can
// declare the window its own harness documents but can never pin a worker
// indefinitely.
//
// The idle limit is opt-in. It only fires when a command produces no output
// for the configured period, so it must stay off for harnesses that are
// silent while healthy (Posse's own runner is silent between lanes unless the
// reporter heartbeat is enabled).

import { createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "./repository-settings.js";

export const VERIFICATION_POLICY_SCHEMA_VERSION = 1;
export const DEFAULT_VERIFICATION_WALL_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFICATION_WALL_TIMEOUT_MAX_MS = 1_800_000;
export const MIN_VERIFICATION_TIMEOUT_MS = 1_000;
export const VERIFICATION_CHECK_CLASSES = Object.freeze(["frozen_test", "canonical_verify", "hook_verify"]);

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function readPositiveInteger(readSetting, key, options) {
  let raw;
  try {
    raw = readSetting(key, options);
  } catch {
    return null;
  }
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function verificationPolicyFingerprint({
  schema_version: schemaVersion = VERIFICATION_POLICY_SCHEMA_VERSION,
  wall_timeout_ms: wallTimeoutMs,
  idle_timeout_ms: idleTimeoutMs = null,
} = {}) {
  return sha256([
    schemaVersion,
    Number(wallTimeoutMs) || 0,
    idleTimeoutMs == null ? "" : Number(idleTimeoutMs) || 0,
  ].join("\0"));
}

const VERIFICATION_IDENTITY_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "composer.json", "composer.lock",
  "requirements.txt", "requirements.lock", "poetry.lock", "uv.lock", "pdm.lock", "pyproject.toml",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
  "Gemfile", "Gemfile.lock", "pom.xml", "gradle.lockfile", "packages.lock.json",
  "posse.verification.json",
]);
const VERIFICATION_IDENTITY_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".posse", ".posse-worktrees", "node_modules", "vendor", "target", "dist", "build", "coverage", "__pycache__",
]);

function stableJson(value) {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

function repositoryIdentityFiles(projectDir, { maxDepth = 4, maxFiles = 96 } = {}) {
  if (!projectDir) return [];
  const root = path.resolve(String(projectDir));
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isFile() && VERIFICATION_IDENTITY_FILES.has(entry.name)) {
        let digest = null;
        try { digest = createHash("sha256").update(fs.readFileSync(full)).digest("hex"); } catch { digest = null; }
        if (digest) files.push({ path: path.relative(root, full).replace(/\\/g, "/"), sha256: digest });
      } else if (entry.isDirectory()
        && current.depth < maxDepth
        && !VERIFICATION_IDENTITY_SKIP_DIRS.has(entry.name)) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function runtimeKinds(identityFiles) {
  const names = new Set(identityFiles.map((entry) => path.basename(entry.path)));
  const kinds = new Set();
  if ([...names].some((name) => ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(name))) kinds.add("node");
  if ([...names].some((name) => ["requirements.txt", "requirements.lock", "poetry.lock", "uv.lock", "pdm.lock", "pyproject.toml"].includes(name))) kinds.add("python");
  if (names.has("composer.json") || names.has("composer.lock")) kinds.add("php");
  if (names.has("go.mod") || names.has("go.sum")) kinds.add("go");
  if (names.has("Cargo.toml") || names.has("Cargo.lock")) kinds.add("rust");
  if (names.has("Gemfile") || names.has("Gemfile.lock")) kinds.add("ruby");
  if (names.has("pom.xml") || names.has("gradle.lockfile")) kinds.add("java");
  if (names.has("packages.lock.json")) kinds.add("dotnet");
  return kinds;
}

function probeVersion(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      shell: process.platform === "win32",
    });
    if ((result.status ?? 1) !== 0) return null;
    return `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/, 1)[0].slice(0, 160) || null;
  } catch {
    return null;
  }
}

function runtimeVersions(kinds) {
  const versions = { node: process.version };
  if (kinds.has("node")) versions.npm = probeVersion(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]);
  if (kinds.has("python")) versions.python = probeVersion(process.platform === "win32" ? "python" : "python3", ["--version"]);
  if (kinds.has("php")) {
    versions.php = probeVersion("php", ["--version"]);
    versions.composer = probeVersion("composer", ["--version", "--no-ansi"]);
  }
  if (kinds.has("go")) versions.go = probeVersion("go", ["version"]);
  if (kinds.has("rust")) versions.cargo = probeVersion("cargo", ["--version"]);
  if (kinds.has("ruby")) versions.ruby = probeVersion("ruby", ["--version"]);
  if (kinds.has("java")) versions.java = probeVersion("java", ["-version"]);
  if (kinds.has("dotnet")) versions.dotnet = probeVersion("dotnet", ["--version"]);
  return versions;
}

export function describeToolchain({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  projectDir = null,
  env = process.env,
} = {}) {
  const identityFiles = repositoryIdentityFiles(projectDir);
  const runtimes = runtimeVersions(runtimeKinds(identityFiles));
  runtimes.node = String(nodeVersion || "");
  return {
    schema_version: 2,
    platform: String(platform || ""),
    arch: String(arch || ""),
    node_version: String(nodeVersion || ""),
    runtimes,
    identity_files: identityFiles,
    environment_profile: {
      ci: String(env?.CI || "").trim().toLowerCase() || null,
      verification_parent_pulse: Boolean(String(env?.POSSE_VERIFICATION_PULSE_CAPABILITY || "").trim()),
    },
  };
}

export function toolchainFingerprint(toolchain = describeToolchain()) {
  const described = toolchain && typeof toolchain === "object" ? toolchain : describeToolchain();
  return sha256(stableJson(described));
}

/**
 * @param {{
 *   projectDir?: string | null,
 *   checkClass?: string,
 *   wallTimeoutMs?: number | null,
 *   idleTimeoutMs?: number | null,
 *   readSetting?: typeof getSetting,
 * }} [options]
 */
export function resolveVerificationPolicy({
  projectDir = null,
  checkClass = "frozen_test",
  wallTimeoutMs = null,
  idleTimeoutMs = null,
  readSetting = getSetting,
} = {}) {
  const repoOptions = projectDir ? { projectDir } : {};
  const adminMax = Math.max(
    MIN_VERIFICATION_TIMEOUT_MS,
    readPositiveInteger(readSetting, "verification_wall_timeout_max_ms", {}) || DEFAULT_VERIFICATION_WALL_TIMEOUT_MAX_MS,
  );

  let wall;
  let wallSource;
  const explicitWall = Number(wallTimeoutMs);
  const repositoryWall = readPositiveInteger(readSetting, "verification_wall_timeout_ms", repoOptions);
  if (Number.isFinite(explicitWall) && explicitWall > 0) {
    wall = explicitWall;
    wallSource = "caller";
  } else if (repositoryWall) {
    wall = repositoryWall;
    wallSource = "repository";
  } else {
    wall = DEFAULT_VERIFICATION_WALL_TIMEOUT_MS;
    wallSource = "default";
  }
  wall = Math.max(MIN_VERIFICATION_TIMEOUT_MS, Math.round(wall));
  if (wall > adminMax) {
    wall = adminMax;
    wallSource = `${wallSource}_clamped_to_admin_max`;
  }

  let idle = null;
  let idleSource = "disabled";
  const explicitIdle = Number(idleTimeoutMs);
  const repositoryIdle = readPositiveInteger(readSetting, "verification_idle_timeout_ms", repoOptions);
  if (Number.isFinite(explicitIdle) && explicitIdle > 0) {
    idle = explicitIdle;
    idleSource = "caller";
  } else if (repositoryIdle) {
    idle = repositoryIdle;
    idleSource = "repository";
  }
  if (idle != null) {
    idle = Math.max(MIN_VERIFICATION_TIMEOUT_MS, Math.min(Math.round(idle), wall));
  }

  const policy = {
    schema_version: VERIFICATION_POLICY_SCHEMA_VERSION,
    check_class: VERIFICATION_CHECK_CLASSES.includes(checkClass) ? checkClass : "frozen_test",
    wall_timeout_ms: wall,
    wall_source: wallSource,
    wall_timeout_max_ms: adminMax,
    idle_timeout_ms: idle,
    idle_source: idleSource,
  };
  return { ...policy, fingerprint: verificationPolicyFingerprint(policy) };
}
