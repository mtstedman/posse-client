// lib/domains/git/functions/hooks.js — deterministic git safety gates
//
// Each hook is a pure function: (context) => { ok: boolean, output: string }
//   ok=true  → continue
//   ok=false → BLOCK (caller aborts with output as error message)
//
// Hooks are deterministic — no LLM involvement. They run synchronously and
// cannot be overridden by agents. Add new hooks by exporting a function that
// follows this pattern.
//
import fs from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { getSetting } from "../../queue/functions/index.js";
import { snapshotPublishingPushConfigs, snapshotPublishingPushConfigsAsync } from "./push-guard.js";
import { gitExec, gitExecAsync, gitExecBuffer, gitExecBufferAsync, isGitCommandFailure } from "./utils.js";
import { SECRET_PATTERNS } from "../../../shared/telemetry/functions/logging/secret-patterns.js";

const VERIFY_COMMAND_TIMEOUT_MS = 120_000;
const VERIFY_COMMAND_HELPER_GRACE_MS = 15_000;
const VERIFY_COMMAND_MAX_CAPTURE = 1024 * 1024 * 4;
const VERIFY_COMMAND_HELPER_MAX_BUFFER = (VERIFY_COMMAND_MAX_CAPTURE * 4) + (1024 * 1024);

const VERIFY_COMMAND_HELPER_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");

const payload = JSON.parse(process.argv[1] || "{}");
const timeoutMs = Math.max(1000, Number(payload.timeoutMs) || 120000);
const maxCapture = Math.max(1024, Number(payload.maxCapture) || 4194304);
let stdout = "";
let stderr = "";
let settled = false;
let timedOut = false;

function appendBounded(current, chunk) {
  const next = current + String(chunk || "");
  return next.length > maxCapture ? next.slice(next.length - maxCapture) : next;
}

function emit(result) {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify({
    status: result.status,
    signal: result.signal || null,
    timedOut: !!result.timedOut,
    stdout,
    stderr,
    error: result.error || null,
  }));
  process.exit(result.status === 0 && !result.timedOut && !result.error ? 0 : 1);
}

function killTree(child) {
  if (process.platform === "win32" && child && child.pid) {
    try {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (killed.status === 0) return true;
    } catch {
      // Fall back to killing the shell wrapper below.
    }
  }
  try { return !!child.kill(); } catch { return false; }
}

if (!payload.command) {
  emit({ status: 1, error: "command is required" });
} else {
  const child = spawn(String(payload.command), {
    cwd: payload.cwd || process.cwd(),
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout && child.stdout.setEncoding && child.stdout.setEncoding("utf8");
  child.stderr && child.stderr.setEncoding && child.stderr.setEncoding("utf8");
  child.stdout && child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr && child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);
  child.on("error", (err) => {
    clearTimeout(timer);
    emit({ status: 1, error: err && err.message ? err.message : String(err || "spawn failed") });
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    emit({ status: timedOut ? 124 : (code == null ? 1 : code), signal, timedOut });
  });
}
`;

function execFileText(command, args, {
  cwd = undefined,
  encoding = "utf-8",
  stdio = ["ignore", "pipe", "pipe"],
  timeout = undefined,
  maxBuffer = undefined,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      encoding,
      stdio,
      timeout,
      maxBuffer,
      windowsHide: true,
    }, (err, stdout = "", stderr = "") => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function readSettingText(key) {
  try {
    const value = getSetting(key);
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

function readSettingBool(key, fallback = false) {
  const value = readSettingText(key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

// ─── Hook runner ────────────────────────────────────────────────────────────

function hookDisabled(hookName) {
  return readSettingBool("skip_hooks", false) || readSettingBool(`skip_hook_${hookName}`, false);
}

function hookThrewResult(hookName, err) {
  return { ok: false, output: `Hook "${hookName}" threw: ${err.message}` };
}

/**
 * Run a named hook. Returns { ok: boolean, output: string }.
 * If the hook is disabled in settings, returns ok.
 */
export function runHook(hookName, ctx) {
  if (hookDisabled(hookName)) return { ok: true, output: "" };

  const hook = HOOKS[hookName];
  if (!hook) return { ok: true, output: "" };

  try {
    return hook(ctx);
  } catch (err) {
    return hookThrewResult(hookName, err);
  }
}

export async function runHookAsync(hookName, ctx) {
  if (hookDisabled(hookName)) return { ok: true, output: "" };

  const hook = ASYNC_HOOKS[hookName] || HOOKS[hookName];
  if (!hook) return { ok: true, output: "" };

  try {
    return await hook(ctx);
  } catch (err) {
    return hookThrewResult(hookName, err);
  }
}

// ─── Hook registry ──────────────────────────────────────────────────────────

const HOOKS = {
  "secrets_scan": secretsScan,
  "post_dev_verify": postDevVerify,
  "pre_push_gate": prePushGate,
};

const ASYNC_HOOKS = {
  "secrets_scan": secretsScanAsync,
  "post_dev_verify": postDevVerifyAsync,
  "pre_push_gate": prePushGateAsync,
};

function _normalizeRepoPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function _isRuntimePath(filePath) {
  const normalized = _normalizeRepoPath(filePath);
  return normalized === ".posse" || normalized.startsWith(".posse/");
}

function parseHookCommandHelperResult(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").trim() || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Fall through to an empty result.
  }
  return {};
}

function commandErrorFromHelperResult(command, result, fallback = {}) {
  const timedOut = !!(result.timedOut || fallback.timedOut);
  const status = result.status ?? fallback.status ?? (timedOut ? 124 : 1);
  const message = timedOut
    ? `Command timed out after ${fallback.timeoutMs || VERIFY_COMMAND_TIMEOUT_MS}ms`
    : (result.error || fallback.error || `Command failed with exit ${status}`);
  const err = new Error(message);
  err.status = status;
  err.signal = result.signal ?? fallback.signal ?? null;
  err.stdout = result.stdout ?? fallback.stdout ?? "";
  err.stderr = result.stderr ?? fallback.stderr ?? "";
  err.timedOut = timedOut;
  err.command = command;
  return err;
}

function hookShellCommandPayload(command, cwd, timeoutMs) {
  return JSON.stringify({
    command,
    cwd,
    timeoutMs,
    maxCapture: VERIFY_COMMAND_MAX_CAPTURE,
  });
}

function hookShellHelperTimeout(timeoutMs) {
  return Math.max(1000, Number(timeoutMs) || VERIFY_COMMAND_TIMEOUT_MS) + VERIFY_COMMAND_HELPER_GRACE_MS;
}

// commandErrorFromHelperResult reads fallback.{status,signal,stdout,stderr,
// timedOut,error}; a past async-only fallback shape used ignored keys, so a
// helper-process death reported "exit 1" with empty output. (B11) Building the
// fallback in one place keeps the twins' error fidelity identical.
function helperDeathError(command, err, timeoutMs) {
  const result = parseHookCommandHelperResult(err.stdout);
  return commandErrorFromHelperResult(command, result, {
    status: err.status,
    signal: err.signal,
    stdout: result.stdout ?? err.stdout ?? "",
    stderr: result.stderr ?? err.stderr ?? "",
    timedOut: err.killed || err.code === "ETIMEDOUT" || result.timedOut,
    timeoutMs,
    error: err.message,
  });
}

function finishHookShellCommand(command, raw, timeoutMs) {
  const result = parseHookCommandHelperResult(raw);
  if ((result.status ?? 0) !== 0 || result.timedOut || result.error) {
    throw commandErrorFromHelperResult(command, result, { timeoutMs });
  }
  return result;
}

function runHookShellCommand(command, { cwd, timeoutMs = VERIFY_COMMAND_TIMEOUT_MS } = {}) {
  let raw = "";
  try {
    raw = execFileSync(process.execPath, ["-e", VERIFY_COMMAND_HELPER_SCRIPT, hookShellCommandPayload(command, cwd, timeoutMs)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: hookShellHelperTimeout(timeoutMs),
      maxBuffer: VERIFY_COMMAND_HELPER_MAX_BUFFER,
    });
  } catch (err) {
    throw helperDeathError(command, err, timeoutMs);
  }
  return finishHookShellCommand(command, raw, timeoutMs);
}

async function runHookShellCommandAsync(command, { cwd, timeoutMs = VERIFY_COMMAND_TIMEOUT_MS } = {}) {
  let raw = "";
  try {
    raw = await execFileText(process.execPath, ["-e", VERIFY_COMMAND_HELPER_SCRIPT, hookShellCommandPayload(command, cwd, timeoutMs)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: hookShellHelperTimeout(timeoutMs),
      maxBuffer: VERIFY_COMMAND_HELPER_MAX_BUFFER,
    });
  } catch (err) {
    throw helperDeathError(command, err, timeoutMs);
  }
  return finishHookShellCommand(command, raw, timeoutMs);
}

export function __testRunHookShellCommand(command, opts = {}) {
  return runHookShellCommand(command, opts);
}

export function __testRunHookShellCommandAsync(command, opts = {}) {
  return runHookShellCommandAsync(command, opts);
}

// ─── secrets_scan ───────────────────────────────────────────────────────────
//
// Scans staged files for leaked credentials before commit.
// ctx: { cwd: string, paths?: string[] }
//
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".lock", ".min.js", ".min.css",
]);

// Shared secrets-scan evaluators: which files scan, how a file's content is
// judged, and how findings render live once — the twins keep only the git
// subprocess gathering. (Past twin-drift bug B10 lived exactly here: the async
// scan fed whole-file content to the diff-only scanner and silently found
// nothing.)
function scannableStagedFiles(staged) {
  return staged.split("\n").filter(Boolean).filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function secretsFindingsForContent(file, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(lines[i])) {
        findings.push(`  ${file}:${i + 1} — ${label}`);
      }
    }
  }
  return findings;
}

function secretsBlockResult(findings) {
  if (findings.length === 0) return { ok: true, output: "" };
  const output = [
    "SECRETS DETECTED — COMMIT BLOCKED",
    "",
    ...findings.slice(0, 20),
    findings.length > 20 ? `  ... and ${findings.length - 20} more` : "",
    "",
    "Remove the secrets before committing.",
    "If these are false positives, set skip_hook_secrets_scan=true in Posse admin.",
  ].filter(Boolean).join("\n");
  return { ok: false, output };
}

// A git check that could not RUN (sync gate busy, posse-git unavailable) is
// not evidence of a clean tree. Security gates fail closed on that class and
// stay fail-open only when git itself ran and said no (isGitCommandFailure),
// matching the pre-native-cutover failure surface.
function gitInfraBlockResult(gateName, err) {
  return {
    ok: false,
    output: [
      `${gateName} blocked: git checks could not run (${String(err?.message || err).split("\n")[0]}).`,
      "This is a git-access failure, not a clean scan. Retry once git access is restored.",
    ].join("\n"),
  };
}

// One `cat-file --batch` fetches every staged blob in a single native call
// (each sync git call is a full posse-git spawn, so per-file `git show` made
// guarded commits pay N spawns).
const STAGED_BATCH_MAX_BUFFER = 1024 * 1024 * 64;

function stagedBatchInput(files) {
  return `${files.map((file) => `:${file}`).join("\n")}\n`;
}

function parseStagedBatch(buf, files) {
  const bodies = new Map();
  let cursor = 0;
  for (const file of files) {
    const nl = buf.indexOf(0x0a, cursor);
    if (nl === -1) break;
    const header = buf.subarray(cursor, nl).toString("utf-8");
    cursor = nl + 1;
    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (parts.length < 3 || !Number.isFinite(size)) {
      // "<spec> missing" — no body line follows.
      bodies.set(file, null);
      continue;
    }
    bodies.set(file, buf.subarray(cursor, cursor + size).toString("utf-8"));
    cursor += size + 1;
  }
  return bodies;
}

function stagedContentsBatch(cwd, files) {
  if (files.length === 0) return new Map();
  try {
    const buf = gitExecBuffer(["cat-file", "--batch"], cwd, {
      input: stagedBatchInput(files),
      maxBuffer: STAGED_BATCH_MAX_BUFFER,
    });
    return parseStagedBatch(buf, files);
  } catch {
    return null;
  }
}

async function stagedContentsBatchAsync(cwd, files) {
  if (files.length === 0) return new Map();
  try {
    const buf = await gitExecBufferAsync(["cat-file", "--batch"], cwd, {
      input: stagedBatchInput(files),
      maxBuffer: STAGED_BATCH_MAX_BUFFER,
    });
    return parseStagedBatch(buf, files);
  } catch {
    return null;
  }
}

function normalizedWorkingTreeScanPaths(paths = []) {
  return [...new Set(paths.map(_normalizeRepoPath).filter(Boolean))]
    .filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function secretsScanWorkingTreePaths(cwd, paths = []) {
  const findings = [];
  for (const file of normalizedWorkingTreeScanPaths(paths)) {
    const fullPath = path.resolve(cwd, file);
    const relative = path.relative(path.resolve(cwd), fullPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    let content;
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) content = fs.readlinkSync(fullPath, "utf-8");
      else if (stat.isFile()) content = fs.readFileSync(fullPath, "utf-8");
      else continue;
    } catch { continue; }
    findings.push(...secretsFindingsForContent(file, content));
  }
  return secretsBlockResult(findings);
}

async function secretsScanWorkingTreePathsAsync(cwd, paths = []) {
  const findings = [];
  for (const file of normalizedWorkingTreeScanPaths(paths)) {
    const fullPath = path.resolve(cwd, file);
    const relative = path.relative(path.resolve(cwd), fullPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    let content;
    try {
      const stat = await fs.promises.lstat(fullPath);
      if (stat.isSymbolicLink()) content = await fs.promises.readlink(fullPath, "utf-8");
      else if (stat.isFile()) content = await fs.promises.readFile(fullPath, "utf-8");
      else continue;
    } catch { continue; }
    findings.push(...secretsFindingsForContent(file, content));
  }
  return secretsBlockResult(findings);
}

function secretsScan({ cwd, paths = null }) {
  // Scoped native commits build their index inside Rust. Scan the exact
  // working-tree paths that transaction will receive so Posse's deterministic
  // gate still runs before any native index or ref mutation.
  if (Array.isArray(paths)) return secretsScanWorkingTreePaths(cwd, paths);
  let staged;
  try {
    staged = gitExec(["diff", "--cached", "--name-only", "--diff-filter=ACM"], cwd).trim();
  } catch (err) {
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Secrets scan", err);
    return { ok: true, output: "" };
  }

  if (!staged) return { ok: true, output: "" };

  const files = scannableStagedFiles(staged);
  const stagedContents = stagedContentsBatch(cwd, files);
  const findings = [];
  for (const file of files) {
    let content = stagedContents?.get(file);
    if (content == null) {
      const fullPath = path.join(cwd, file);
      if (!fs.existsSync(fullPath)) continue;
      try { content = fs.readFileSync(fullPath, "utf-8"); } catch { continue; }
    }
    findings.push(...secretsFindingsForContent(file, content));
  }

  return secretsBlockResult(findings);
}

async function secretsScanAsync({ cwd, paths = null }) {
  if (Array.isArray(paths)) return secretsScanWorkingTreePathsAsync(cwd, paths);
  let staged;
  try {
    staged = (await gitExecAsync(["diff", "--cached", "--name-only", "--diff-filter=ACM"], cwd)).trim();
  } catch (err) {
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Secrets scan", err);
    return { ok: true, output: "" };
  }

  if (!staged) return { ok: true, output: "" };

  const files = scannableStagedFiles(staged);
  const stagedContents = await stagedContentsBatchAsync(cwd, files);
  const findings = [];
  for (const file of files) {
    let content = stagedContents?.get(file);
    if (content == null) {
      const fullPath = path.join(cwd, file);
      if (!fs.existsSync(fullPath)) continue;
      try { content = await fs.promises.readFile(fullPath, "utf-8"); } catch { continue; }
    }
    findings.push(...secretsFindingsForContent(file, content));
  }

  return secretsBlockResult(findings);
}

// ─── post_dev_verify ────────────────────────────────────────────────────────
//
// Runs the configured pre_assess_cmd after commit, before assessment.
// If the command fails, blocks so assessment is skipped (no point assessing
// code that doesn't build).
// ctx: { cwd: string }
//
// Shared failure formatter for verify-command hooks. Keeps only the tail of
// the captured output to avoid flooding logs. The heading is caller-supplied
// (post_dev_verify vs pre_push_gate word their blocks differently).
function verifyCommandFailureOutput(heading, cmd, err, tailLines) {
  const raw = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
  return [
    heading,
    `Command: ${cmd}`,
    "",
    raw.split("\n").slice(-tailLines).join("\n"),
  ].join("\n");
}

function postDevVerify({ cwd }) {
  const cmd = readSettingText("pre_assess_cmd");
  if (!cmd) return { ok: true, output: "" };

  try {
    runHookShellCommand(cmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    return { ok: true, output: "" };
  } catch (err) {
    return { ok: false, output: postDevVerifyFailureOutput(cmd, err) };
  }
}

async function postDevVerifyAsync({ cwd }) {
  const cmd = readSettingText("pre_assess_cmd");
  if (!cmd) return { ok: true, output: "" };

  try {
    await runHookShellCommandAsync(cmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    return { ok: true, output: "" };
  } catch (err) {
    return { ok: false, output: postDevVerifyFailureOutput(cmd, err) };
  }
}

function postDevVerifyFailureOutput(cmd, err) {
  return verifyCommandFailureOutput(`Build/lint verification failed (exit ${err.status ?? "?"})`, cmd, err, 80);
}

// —— pre_push_gate ——————————————————————————————————————————————————————————————
//
// Final deterministic guard before pushing the target branch.
// Checks for a dirty tree, obvious env-file mistakes in unpushed commits,
// secret-looking additions in the push diff, and optionally runs a project-
// level verification command.
//
// ctx: { cwd: string, targetBranch?: string }
//
// Config:
//   pre_push_verify_cmd   Optional command to run before push

// Shared pre-push evaluators: every block decision and its user-visible
// wording lives once so the twins cannot drift (the risky-push and verify
// messages had already diverged between them before this extraction).
function prePushBlock(lines) {
  return { ok: false, output: ["Push blocked by pre-push gate.", ...lines].join("\n") };
}

function riskyPushConfigBlock(riskyPushConfigs) {
  if (riskyPushConfigs.length === 0) return null;
  return prePushBlock([
    "Remote push configuration could publish Posse recovery snapshot refs:",
    ...riskyPushConfigs.slice(0, 10).map((entry) => `  ${entry.key}=${entry.value}`),
    "Run Posse once to rewrite remote push refspecs, or set remote.<name>.push to HEAD/refs/heads only.",
  ]);
}

function dirtyStatusBlock(status) {
  if (!status) return null;
  const relevantStatus = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !_isRuntimePath(line.slice(3).trim()));
  if (relevantStatus.length === 0) return null;
  return prePushBlock([
    "Working tree is not clean:",
    ...relevantStatus.slice(0, 20),
  ]);
}

function envFileBlock(names) {
  const envFiles = names
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(^|\/)\.env($|\.)/i.test(line));
  if (envFiles.length === 0) return null;
  return prePushBlock([
    "Unpushed commits include .env-style files:",
    ...envFiles.slice(0, 10).map((file) => `  ${file}`),
  ]);
}

function pushDiffSecretsBlock(diff) {
  const findings = _scanTextForSecrets(diff);
  if (findings.length === 0) return null;
  return prePushBlock([
    "Possible secrets detected in unpushed diff:",
    ...findings.slice(0, 10).map((finding) => `  ${finding}`),
  ]);
}

function prePushVerifyFailure(verifyCmd, err) {
  return {
    ok: false,
    output: verifyCommandFailureOutput(
      `Push blocked by pre-push verify command (exit ${err.status ?? "?"}).`,
      verifyCmd,
      err,
      40,
    ),
  };
}

function prePushGate({ cwd, nativeParity = {} }) {
  const riskyBlock = riskyPushConfigBlock(snapshotPublishingPushConfigs(cwd, nativeParity));
  if (riskyBlock) return riskyBlock;

  let status = "";
  try {
    status = gitExec(["status", "--porcelain"], cwd).trim();
  } catch (err) {
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
    return { ok: true, output: "" };
  }

  const dirtyBlock = dirtyStatusBlock(status);
  if (dirtyBlock) return dirtyBlock;

  let upstream = "";
  try {
    upstream = gitExec(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd).trim();
  } catch (err) {
    // no upstream is allowed; infra failures are not
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
  }

  if (upstream) {
    try {
      const names = gitExec(["diff", "--name-only", `${upstream}..HEAD`], cwd).trim();
      const envBlock = envFileBlock(names);
      if (envBlock) return envBlock;

      const diff = gitExec(["diff", `${upstream}..HEAD`, "--unified=0"], cwd, { maxBuffer: 1024 * 1024 * 4, trim: false });
      const secretsBlock = pushDiffSecretsBlock(diff);
      if (secretsBlock) return secretsBlock;
    } catch (err) {
      // best effort for git failures only
      if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
    }
  }

  const verifyCmd = readSettingText("pre_push_verify_cmd");
  if (verifyCmd) {
    try {
      runHookShellCommand(verifyCmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    } catch (err) {
      return prePushVerifyFailure(verifyCmd, err);
    }
  }

  return { ok: true, output: "" };
}

async function prePushGateAsync({ cwd, nativeParity = {} }) {
  const riskyBlock = riskyPushConfigBlock(await snapshotPublishingPushConfigsAsync(cwd, nativeParity));
  if (riskyBlock) return riskyBlock;

  let status = "";
  try {
    status = (await gitExecAsync(["status", "--porcelain"], cwd)).trim();
  } catch (err) {
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
    return { ok: true, output: "" };
  }

  const dirtyBlock = dirtyStatusBlock(status);
  if (dirtyBlock) return dirtyBlock;

  let upstream = "";
  try {
    upstream = (await gitExecAsync(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd)).trim();
  } catch (err) {
    // no upstream is allowed; infra failures are not
    if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
  }

  if (upstream) {
    try {
      const names = (await gitExecAsync(["diff", "--name-only", `${upstream}..HEAD`], cwd)).trim();
      const envBlock = envFileBlock(names);
      if (envBlock) return envBlock;

      const diff = await gitExecAsync(["diff", `${upstream}..HEAD`, "--unified=0"], cwd, { maxBuffer: 1024 * 1024 * 4, trim: false });
      const secretsBlock = pushDiffSecretsBlock(diff);
      if (secretsBlock) return secretsBlock;
    } catch (err) {
      // best effort for git failures only
      if (!isGitCommandFailure(err)) return gitInfraBlockResult("Pre-push gate", err);
    }
  }

  const verifyCmd = readSettingText("pre_push_verify_cmd");
  if (verifyCmd) {
    try {
      await runHookShellCommandAsync(verifyCmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    } catch (err) {
      return prePushVerifyFailure(verifyCmd, err);
    }
  }

  return { ok: true, output: "" };
}

function _scanTextForSecrets(text) {
  const findings = [];
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const addedText = line.slice(1);
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(addedText)) findings.push(`${label}: ${addedText.slice(0, 160)}`);
    }
  }
  return findings;
}
