// Lock-backed dependency readiness for repository verification. These
// adapters are intentionally narrower than the interactive dependency doctor:
// they never invent dependencies, update a lockfile, or run lifecycle scripts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { managedInstallStateRoot } from "../../../shared/platform/functions/managed-install-state.js";

export const VERIFICATION_DEPENDENCY_NETWORK_POLICIES = Object.freeze([
  "cache_only",
  "allow",
  "disabled",
]);

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_SETTLE_MS = 5_000;

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function directoryExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function executableName(command) {
  const value = String(command || "").trim();
  const match = value.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return path.basename(match?.[1] || match?.[2] || match?.[3] || "").toLowerCase();
}

function combinedOutput(receipt = {}) {
  return `${receipt?.stdout || ""}\n${receipt?.stderr || ""}`.toLowerCase();
}

function normalizedNetworkPolicy(value) {
  const policy = String(value || "cache_only").trim().toLowerCase();
  return VERIFICATION_DEPENDENCY_NETWORK_POLICIES.includes(policy) ? policy : "cache_only";
}

function nodeDetection(projectDir) {
  const candidates = [
    ["npm", "package-lock.json"],
    ["npm", "npm-shrinkwrap.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ];
  const found = candidates.find(([, lock]) => exists(path.join(projectDir, lock)));
  return found ? { manager: found[0], lock: found[1] } : null;
}

function pythonRequirements(projectDir) {
  const file = path.join(projectDir, "requirements.txt");
  if (!exists(file)) return null;
  const logicalLines = fs.readFileSync(file, "utf8")
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
  if (logicalLines.length === 0) return { file, safe: false, reason: "requirements.txt is empty" };
  const unsafe = logicalLines.find((line) => (
    line.startsWith("-")
    || !/^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_.,-]+\])?==[^\s;]+(?:\s+--hash=sha256:[a-f0-9]{64})+(?:\s*;.*)?$/i.test(line)
  ));
  const hasPytest = logicalLines.some((line) => /^pytest(?:\[[^\]]+\])?==/i.test(line));
  return unsafe
    ? { file, safe: false, reason: "requirements.txt must use exact == pins and sha256 hashes for every requirement" }
    : !hasPytest
      ? { file, safe: false, reason: "hash-pinned requirements.txt must declare pytest for verification repair" }
    : { file, safe: true, reason: null };
}

function pythonExecutable(projectDir) {
  const relative = process.platform === "win32"
    ? path.join(".venv", "Scripts", "python.exe")
    : path.join(".venv", "bin", "python");
  const command = path.join(projectDir, relative);
  return exists(command) ? command : null;
}

function selectedEcosystems({ projectDir, command, receipt }) {
  const executable = executableName(command);
  const output = combinedOutput(receipt);
  const selected = new Set();
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe", "node", "node.exe"].includes(executable)) {
    selected.add("node");
  }
  if (/^(?:python(?:\d+(?:\.\d+)*)?|py|pytest(?:-\d+(?:\.\d+)*)?)(?:\.exe)?$/.test(executable)
    || /\b(?:pytest|python):?\s*(?:not found|command not found)|no module named ['"]?pytest/i.test(output)) {
    selected.add("python");
  }
  if (["composer", "composer.bat", "php", "php.exe", "phpunit", "phpunit.bat"].includes(executable)
    || /vendor[\\/]autoload\.php|class ["'][^"']+["'] not found/i.test(output)) {
    selected.add("composer");
  }
  if (["go", "go.exe"].includes(executable) || /\bgo:\s+(?:command )?not found/i.test(output)) selected.add("go");
  if (["cargo", "cargo.exe"].includes(executable) || /\bcargo:\s+(?:command )?not found/i.test(output)) selected.add("cargo");

  // A package script can hide the missing runner. Only add an ecosystem when
  // its manifest is present, so arbitrary stderr text cannot authorize work.
  if (selected.has("node") && /(?:pytest|python)/i.test(output) && pythonRequirements(projectDir)) selected.add("python");
  if (selected.has("node") && /\b(?:cargo|rustc)\b/i.test(output) && exists(path.join(projectDir, "Cargo.toml"))) selected.add("cargo");
  if (selected.has("node") && /\bgo\b/i.test(output) && exists(path.join(projectDir, "go.mod"))) selected.add("go");
  return [...selected];
}

function cacheRoot(projectDir, ecosystem, lockPath) {
  const identity = lockPath && exists(lockPath) ? hashFile(lockPath) : "no-lock";
  return path.join(managedInstallStateRoot(projectDir), "verification-deps", ecosystem, identity.slice(0, 16));
}

function commandSpec(ecosystem, projectDir, networkPolicy) {
  const offline = networkPolicy === "cache_only";
  if (ecosystem === "node") {
    const detected = nodeDetection(projectDir);
    if (!detected) return { ok: false, reason: "node_lockfile_missing" };
    const lockPath = path.join(projectDir, detected.lock);
    const cache = cacheRoot(projectDir, "node", lockPath);
    if (detected.manager === "npm") return {
      ok: true,
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["ci", "--include=optional", "--ignore-scripts", "--cache", cache, ...(offline ? ["--offline"] : [])],
      lockPath,
      generated: ["node_modules"],
    };
    if (detected.manager === "pnpm") return {
      ok: true,
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["install", "--frozen-lockfile", "--ignore-scripts", "--store-dir", cache, ...(offline ? ["--offline"] : [])],
      lockPath,
      generated: ["node_modules"],
    };
    if (detected.manager === "yarn") return {
      ok: true,
      command: process.platform === "win32" ? "yarn.cmd" : "yarn",
      args: ["install", "--frozen-lockfile", "--ignore-scripts", "--cache-folder", cache, ...(offline ? ["--offline"] : [])],
      lockPath,
      generated: ["node_modules"],
    };
    return {
      ok: true,
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["install", "--frozen-lockfile", "--ignore-scripts", ...(offline ? ["--offline"] : [])],
      lockPath,
      generated: ["node_modules"],
    };
  }
  if (ecosystem === "composer") {
    const lockPath = path.join(projectDir, "composer.lock");
    if (!exists(lockPath)) return { ok: false, reason: "composer_lockfile_missing" };
    return {
      ok: true,
      command: "composer",
      args: ["install", "--no-interaction", "--no-progress", "--no-ansi", "--no-scripts", "--no-plugins"],
      env: offline ? { COMPOSER_DISABLE_NETWORK: "1" } : {},
      lockPath,
      generated: ["vendor"],
    };
  }
  if (ecosystem === "python") {
    const requirements = pythonRequirements(projectDir);
    if (!requirements?.safe) return { ok: false, reason: requirements?.reason || "hash_pinned_requirements_missing" };
    const python = pythonExecutable(projectDir);
    if (!python) return { ok: false, reason: "python_verification_requires_existing_.venv" };
    return {
      ok: true,
      command: python,
      args: ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", ...(offline ? ["--no-index"] : []), "-r", requirements.file],
      lockPath: requirements.file,
      generated: [".venv"],
    };
  }
  if (ecosystem === "go") {
    const lockPath = path.join(projectDir, "go.sum");
    if (!exists(path.join(projectDir, "go.mod")) || !exists(lockPath)) return { ok: false, reason: "go_mod_and_sum_required" };
    return {
      ok: true,
      command: "go",
      args: ["mod", "download"],
      env: { GOFLAGS: "-mod=readonly", ...(offline ? { GOPROXY: "off" } : {}) },
      lockPath,
      generated: [],
    };
  }
  if (ecosystem === "cargo") {
    const lockPath = path.join(projectDir, "Cargo.lock");
    if (!exists(path.join(projectDir, "Cargo.toml")) || !exists(lockPath)) return { ok: false, reason: "cargo_toml_and_lock_required" };
    return {
      ok: true,
      command: "cargo",
      args: ["fetch", "--locked", ...(offline ? ["--offline"] : [])],
      env: { CARGO_HOME: cacheRoot(projectDir, "cargo", lockPath) },
      lockPath,
      generated: ["target"],
    };
  }
  return { ok: false, reason: "unsupported_verification_ecosystem" };
}

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk || "")}`;
  return next.length <= MAX_OUTPUT_BYTES ? next : next.slice(-MAX_OUTPUT_BYTES);
}

function killProcessTree(child, { force = false } = {}) {
  if (process.platform !== "win32" && child?.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child when it never became a process group.
    }
  }
  if (process.platform === "win32" && child?.pid) {
    try {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result?.status === 0) return;
    } catch {
      // Fall through to the direct child.
    }
  }
  try { child?.kill?.(force ? "SIGKILL" : "SIGTERM"); } catch { /* best effort */ }
}

export function runVerificationPrerequisiteCommand(command, args, {
  cwd,
  env = {},
  signal = null,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    let timer = null;
    let forceTimer = null;
    let settleTimer = null;
    let terminationResult = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ stdout, stderr, ...result });
    };
    const terminate = (result) => {
      if (settled || terminationResult) return;
      terminationResult = result;
      killProcessTree(child);
      // Do not let the direct child's close event win the race and turn a
      // cancellation into a generic non-zero exit. Always perform the bounded
      // group-wide KILL pass before resolving, because a descendant can ignore
      // TERM after its group leader has already exited.
      forceTimer = setTimeout(() => {
        killProcessTree(child, { force: true });
        finish(terminationResult);
      }, TERMINATION_GRACE_MS);
      forceTimer.unref?.();
      settleTimer = setTimeout(() => {
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
        finish(result);
      }, TERMINATION_SETTLE_MS);
      settleTimer.unref?.();
    };
    const onAbort = () => terminate({ ok: false, status: "cancelled", code: null, reason: "cancelled" });
    try {
      child = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, status: "blocked", code: null, reason: error?.code || "spawn_failed", stdout, stderr });
      return;
    }
    timer = setTimeout(() => terminate({
      ok: false,
      status: "blocked",
      code: null,
      reason: "dependency_repair_timeout",
    }), Math.max(1000, Number(timeoutMs) || 10 * 60 * 1000));
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      if (!terminationResult) finish({ ok: false, status: "blocked", code: null, reason: error?.code || "spawn_failed" });
    });
    child.on("close", (code) => {
      if (!terminationResult) finish({ ok: code === 0, status: code === 0 ? "passed" : "blocked", code, reason: code === 0 ? null : "dependency_repair_failed" });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function defaultGitStatus(projectDir) {
  return runVerificationPrerequisiteCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectDir,
    timeoutMs: 30_000,
  }).then((result) => result.ok ? result.stdout : null);
}

function verificationResult(ecosystem, status, detail = {}) {
  return {
    ecosystem,
    status,
    ok: status === "passed",
    actionability: status === "side_effect_detected" ? "repository_cleanup" : "infrastructure",
    retry_class: status === "cancelled" ? "none" : "verification_infrastructure",
    ...detail,
  };
}

function classifyRepairFailure(run, networkPolicy) {
  if (run?.ok) return { reason: null, network_required: false, credentials_required: false };
  const output = `${run?.stdout || ""}\n${run?.stderr || ""}`;
  const credentialsRequired = /\b(?:401|403|unauthorized|forbidden|authentication required|invalid token|credentials?)\b/i.test(output);
  const cacheCorrupt = /\b(?:integrity|checksum|corrupt|unexpected end of (?:file|data)|invalid tar|bad archive)\b/i.test(output);
  const cacheMiss = networkPolicy === "cache_only" && /\b(?:offline|cache miss|not in cache|no cached|could not resolve|network is disabled|goproxy=off)\b/i.test(output);
  return {
    reason: credentialsRequired
      ? "verification_dependency_credentials_required"
      : cacheCorrupt
        ? "verification_dependency_cache_corrupt"
        : cacheMiss
          ? "verification_dependency_cache_miss"
          : run?.reason || "dependency_repair_failed",
    network_required: cacheMiss,
    credentials_required: credentialsRequired,
  };
}

export const VERIFICATION_PREREQUISITE_ADAPTERS = Object.freeze(Object.fromEntries(
  ["node", "composer", "python", "go", "cargo"].map((ecosystem) => [ecosystem, Object.freeze({
    detect(input) {
      return selectedEcosystems(input).includes(ecosystem);
    },
    probe({ projectDir }) {
      if (ecosystem === "node") return directoryExists(path.join(projectDir, "node_modules"));
      if (ecosystem === "composer") return exists(path.join(projectDir, "vendor", "autoload.php"));
      if (ecosystem === "python") return Boolean(pythonExecutable(projectDir));
      return exists(path.join(projectDir, ecosystem === "go" ? "go.sum" : "Cargo.lock"));
    },
    repair({ projectDir, networkPolicy }) {
      return commandSpec(ecosystem, projectDir, networkPolicy);
    },
    verify({ projectDir }) {
      return this.probe({ projectDir });
    },
    explain(result) {
      return result?.reason || `${ecosystem} verification prerequisite unavailable`;
    },
  })]),
));

export async function repairVerificationPrerequisites({
  projectDir,
  command,
  receipt = null,
  networkPolicy = "cache_only",
  signal = null,
  timeoutMs = 10 * 60 * 1000,
  onProgress = null,
  runCommand = runVerificationPrerequisiteCommand,
  gitStatus = defaultGitStatus,
} = {}) {
  const root = path.resolve(String(projectDir || process.cwd()));
  const policy = normalizedNetworkPolicy(networkPolicy);
  const ecosystems = selectedEcosystems({ projectDir: root, command, receipt });
  if (ecosystems.length === 0) {
    return {
      ok: false,
      status: "blocked",
      reason: "no_safe_prerequisite_adapter",
      network_policy: policy,
      results: [],
    };
  }
  if (policy === "disabled") {
    return {
      ok: false,
      status: "blocked",
      reason: "verification_dependency_repair_disabled",
      network_policy: policy,
      results: ecosystems.map((ecosystem) => verificationResult(ecosystem, "blocked", { reason: "network_policy_disabled" })),
    };
  }

  return withDependencyInstallLock(root, async () => {
    const before = await gitStatus(root);
    if (before == null) {
      return { ok: false, status: "blocked", reason: "git_state_unavailable", network_policy: policy, results: [] };
    }
    const results = [];
    for (const ecosystem of ecosystems) {
      const adapter = VERIFICATION_PREREQUISITE_ADAPTERS[ecosystem];
      const spec = adapter.repair({ projectDir: root, networkPolicy: policy });
      if (!spec.ok) {
        results.push(verificationResult(ecosystem, "blocked", { reason: spec.reason }));
        continue;
      }
      onProgress?.(`${ecosystem}: ${spec.command} ${spec.args.join(" ")}`);
      const run = await runCommand(spec.command, spec.args, {
        cwd: root,
        env: spec.env,
        signal,
        timeoutMs,
      });
      const failure = classifyRepairFailure(run, policy);
      results.push(verificationResult(ecosystem, run.status === "passed" ? "passed" : run.status, {
        reason: failure.reason,
        network_required: failure.network_required,
        credentials_required: failure.credentials_required,
        command: [spec.command, ...spec.args].join(" "),
        lockfile: path.relative(root, spec.lockPath).replace(/\\/g, "/"),
        lockfile_sha256: hashFile(spec.lockPath),
        network_policy: policy,
        stdout: run.stdout,
        stderr: run.stderr,
      }));
      if (!run.ok) continue;
      if (!adapter.verify({ projectDir: root })) {
        results[results.length - 1] = verificationResult(ecosystem, "blocked", {
          ...results[results.length - 1],
          reason: "dependency_verification_failed",
        });
      }
    }
    const after = await gitStatus(root);
    if (after == null || after !== before) {
      return {
        ok: false,
        status: "side_effect_detected",
        reason: after == null ? "git_state_unavailable_after_repair" : "dependency_repair_changed_repository",
        network_policy: policy,
        results: results.map((result) => result.ok
          ? verificationResult(result.ecosystem, "side_effect_detected", { ...result, reason: "dependency_repair_changed_repository" })
          : result),
      };
    }
    const ok = results.length > 0 && results.every((result) => result.ok);
    return {
      ok,
      status: ok ? "passed" : results.some((result) => result.status === "cancelled") ? "cancelled" : "blocked",
      reason: ok ? null : results.find((result) => !result.ok)?.reason || "dependency_repair_failed",
      network_policy: policy,
      results,
    };
  }, { waitMs: timeoutMs, onProgress });
}
