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
import { execFile, execFileSync, execSync } from "child_process";
import { getSetting } from "../../queue/functions/index.js";
import { snapshotPublishingPushConfigs, snapshotPublishingPushConfigsAsync } from "./push-guard.js";
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

/**
 * Run a named hook. Returns { ok: boolean, output: string }.
 * If the hook is disabled in settings, returns ok.
 */
export function runHook(hookName, ctx) {
  if (readSettingBool("skip_hooks", false)) return { ok: true, output: "" };
  if (readSettingBool(`skip_hook_${hookName}`, false)) return { ok: true, output: "" };

  const hook = HOOKS[hookName];
  if (!hook) return { ok: true, output: "" };

  try {
    return hook(ctx);
  } catch (err) {
    return { ok: false, output: `Hook "${hookName}" threw: ${err.message}` };
  }
}

export async function runHookAsync(hookName, ctx) {
  if (readSettingBool("skip_hooks", false)) return { ok: true, output: "" };
  if (readSettingBool(`skip_hook_${hookName}`, false)) return { ok: true, output: "" };

  const hook = ASYNC_HOOKS[hookName] || HOOKS[hookName];
  if (!hook) return { ok: true, output: "" };

  try {
    return await hook(ctx);
  } catch (err) {
    return { ok: false, output: `Hook "${hookName}" threw: ${err.message}` };
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

function runHookShellCommand(command, { cwd, timeoutMs = VERIFY_COMMAND_TIMEOUT_MS } = {}) {
  const payload = JSON.stringify({
    command,
    cwd,
    timeoutMs,
    maxCapture: VERIFY_COMMAND_MAX_CAPTURE,
  });
  const helperTimeout = Math.max(1000, Number(timeoutMs) || VERIFY_COMMAND_TIMEOUT_MS) + VERIFY_COMMAND_HELPER_GRACE_MS;
  let raw = "";
  try {
    raw = execFileSync(process.execPath, ["-e", VERIFY_COMMAND_HELPER_SCRIPT, payload], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: helperTimeout,
      maxBuffer: VERIFY_COMMAND_HELPER_MAX_BUFFER,
    });
  } catch (err) {
    const result = parseHookCommandHelperResult(err.stdout);
    throw commandErrorFromHelperResult(command, result, {
      status: err.status,
      signal: err.signal,
      stdout: result.stdout ?? err.stdout ?? "",
      stderr: result.stderr ?? err.stderr ?? "",
      timedOut: err.killed || err.code === "ETIMEDOUT" || result.timedOut,
      timeoutMs,
      error: err.message,
    });
  }
  const result = parseHookCommandHelperResult(raw);
  if ((result.status ?? 0) !== 0 || result.timedOut || result.error) {
    throw commandErrorFromHelperResult(command, result, { timeoutMs });
  }
  return result;
}

async function runHookShellCommandAsync(command, { cwd, timeoutMs = VERIFY_COMMAND_TIMEOUT_MS } = {}) {
  const payload = JSON.stringify({
    command,
    cwd,
    timeoutMs,
    maxCapture: VERIFY_COMMAND_MAX_CAPTURE,
  });
  const helperTimeout = Math.max(1000, Number(timeoutMs) || VERIFY_COMMAND_TIMEOUT_MS) + VERIFY_COMMAND_HELPER_GRACE_MS;
  let raw = "";
  try {
    raw = await execFileText(process.execPath, ["-e", VERIFY_COMMAND_HELPER_SCRIPT, payload], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: helperTimeout,
      maxBuffer: VERIFY_COMMAND_HELPER_MAX_BUFFER,
    });
  } catch (err) {
    const result = parseHookCommandHelperResult(err.stdout);
    // commandErrorFromHelperResult reads fallback.{status,signal,stdout,stderr,
    // timedOut,error}; the old {helperError,fallbackStatus} keys were ignored,
    // so a helper-process death reported "exit 1" with empty output. Mirror the
    // sync path's fallback shape. (B11)
    throw commandErrorFromHelperResult(command, result, {
      status: err.status,
      signal: err.signal,
      stdout: result.stdout ?? err.stdout ?? "",
      stderr: result.stderr ?? err.stderr ?? "",
      timedOut: err.killed || err.code === "ETIMEDOUT" || result.timedOut,
      timeoutMs,
      error: err.message,
    });
  }
  const result = parseHookCommandHelperResult(raw);
  if ((result.status ?? 0) !== 0 || result.timedOut || result.error) {
    throw commandErrorFromHelperResult(command, result, { timeoutMs });
  }
  return result;
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
// ctx: { cwd: string }
//
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".lock", ".min.js", ".min.css",
]);

function secretsScan({ cwd }) {
  let staged;
  try {
    staged = execSync("git diff --cached --name-only --diff-filter=ACM", {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch { return { ok: true, output: "" }; }

  if (!staged) return { ok: true, output: "" };

  const findings = [];

  for (const file of staged.split("\n").filter(Boolean)) {
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    let content;
    try {
      content = execFileSync("git", ["show", `:${file}`], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch {
      const fullPath = path.join(cwd, file);
      if (!fs.existsSync(fullPath)) continue;
      try { content = fs.readFileSync(fullPath, "utf-8"); } catch { continue; }
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(lines[i])) {
          findings.push(`  ${file}:${i + 1} — ${label}`);
        }
      }
    }
  }

  if (findings.length === 0) return { ok: true, output: "" };

  const output = [
    "SECRETS DETECTED — COMMIT BLOCKED",
    "",
    ...findings.slice(0, 20),
    findings.length > 20 ? `  ... and ${findings.length - 20} more` : "",
    "",
    "Remove the secrets and re-stage before committing.",
    "If these are false positives, set skip_hook_secrets_scan=true in Posse admin.",
  ].filter(Boolean).join("\n");

  return { ok: false, output };
}

async function secretsScanAsync({ cwd }) {
  let staged;
  try {
    staged = (await execFileText("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })).trim();
  } catch { return { ok: true, output: "" }; }

  if (!staged) return { ok: true, output: "" };

  const findings = [];

  for (const file of staged.split("\n").filter(Boolean)) {
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    let content;
    try {
      content = await execFileText("git", ["show", `:${file}`], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch {
      const fullPath = path.join(cwd, file);
      if (!fs.existsSync(fullPath)) continue;
      try { content = await fs.promises.readFile(fullPath, "utf-8"); } catch { continue; }
    }

    // Scan whole-file content line-by-line, mirroring the sync `secretsScan`.
    // `_scanTextForSecrets` only inspects diff-style `+` lines, so feeding it
    // full file content found nothing — a fail-open no-op. (B10)
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(lines[i])) {
          findings.push(`  ${file}:${i + 1} — ${label}`);
        }
      }
    }
  }

  if (findings.length === 0) return { ok: true, output: "" };

  const output = [
    "SECRETS DETECTED — COMMIT BLOCKED",
    "",
    ...findings.slice(0, 20),
    findings.length > 20 ? `  ... and ${findings.length - 20} more` : "",
    "",
    "Remove the secrets and re-stage before committing.",
    "If these are false positives, set skip_hook_secrets_scan=true in Posse admin.",
  ].filter(Boolean).join("\n");

  return { ok: false, output };
}

// ─── post_dev_verify ────────────────────────────────────────────────────────
//
// Runs the configured pre_assess_cmd after commit, before assessment.
// If the command fails, blocks so assessment is skipped (no point assessing
// code that doesn't build).
// ctx: { cwd: string }
//
function postDevVerify({ cwd }) {
  const cmd = readSettingText("pre_assess_cmd");
  if (!cmd) return { ok: true, output: "" };

  try {
    runHookShellCommand(cmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    return { ok: true, output: "" };
  } catch (err) {
    const raw = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
    // Keep last 80 lines to avoid flooding logs
    const truncated = raw.split("\n").slice(-80).join("\n");
    const output = [
      `Build/lint verification failed (exit ${err.status ?? "?"})`,
      `Command: ${cmd}`,
      "",
      truncated,
    ].join("\n");
    return { ok: false, output };
  }
}

async function postDevVerifyAsync({ cwd }) {
  const cmd = readSettingText("pre_assess_cmd");
  if (!cmd) return { ok: true, output: "" };

  try {
    await runHookShellCommandAsync(cmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    return { ok: true, output: "" };
  } catch (err) {
    const raw = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
    const truncated = raw.split("\n").slice(-80).join("\n");
    return {
      ok: false,
      output: [
        `pre_assess_cmd failed (exit ${err.status ?? "?"})`,
        `Command: ${cmd}`,
        "",
        truncated,
      ].join("\n"),
    };
  }
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

function prePushGate({ cwd, nativeParity = {} }) {
  const riskyPushConfigs = snapshotPublishingPushConfigs(cwd, nativeParity);
  if (riskyPushConfigs.length > 0) {
    return {
      ok: false,
      output: [
        "Push blocked by pre-push gate.",
        "Remote push configuration could publish Posse recovery snapshot refs:",
        ...riskyPushConfigs.slice(0, 10).map((entry) => `  ${entry.key}=${entry.value}`),
        "Run Posse once to rewrite remote push refspecs, or set remote.<name>.push to HEAD/refs/heads only.",
      ].join("\n"),
    };
  }

  let status = "";
  try {
    status = execSync("git status --porcelain", {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return { ok: true, output: "" };
  }

  if (status) {
    const relevantStatus = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !_isRuntimePath(line.slice(3).trim()));
    if (relevantStatus.length === 0) {
      status = "";
    } else {
      status = relevantStatus.join("\n");
    }
  }

  if (status) {
    return {
      ok: false,
      output: [
        "Push blocked by pre-push gate.",
        "Working tree is not clean:",
        ...status.split("\n").slice(0, 20),
      ].join("\n"),
    };
  }

  let upstream = "";
  try {
    upstream = execSync("git rev-parse --abbrev-ref @{upstream}", {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch { /* no upstream is allowed */ }

  if (upstream) {
    try {
      const names = execFileSync("git", ["diff", "--name-only", `${upstream}..HEAD`], {
        cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const envFiles = names
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /(^|\/)\.env($|\.)/i.test(line));
      if (envFiles.length > 0) {
        return {
          ok: false,
          output: [
            "Push blocked by pre-push gate.",
            "Unpushed commits include .env-style files:",
            ...envFiles.slice(0, 10).map((file) => `  ${file}`),
          ].join("\n"),
        };
      }

      const diff = execFileSync("git", ["diff", `${upstream}..HEAD`, "--unified=0"], {
        cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 4,
      });
      const findings = _scanTextForSecrets(diff);
      if (findings.length > 0) {
        return {
          ok: false,
          output: [
            "Push blocked by pre-push gate.",
            "Possible secrets detected in unpushed diff:",
            ...findings.slice(0, 10).map((finding) => `  ${finding}`),
          ].join("\n"),
        };
      }
    } catch { /* best effort */ }
  }

  const verifyCmd = readSettingText("pre_push_verify_cmd");
  if (verifyCmd) {
    try {
      runHookShellCommand(verifyCmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    } catch (err) {
      const raw = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
      return {
        ok: false,
        output: [
          `Push blocked by pre-push verify command (exit ${err.status ?? "?"}).`,
          `Command: ${verifyCmd}`,
          "",
          ...raw.split("\n").slice(-40),
        ].join("\n"),
      };
    }
  }

  return { ok: true, output: "" };
}

async function prePushGateAsync({ cwd, nativeParity = {} }) {
  const riskyPushConfigs = await snapshotPublishingPushConfigsAsync(cwd, nativeParity);
  if (riskyPushConfigs.length > 0) {
    return {
      ok: false,
      output: [
        "Push blocked by pre-push gate.",
        "Remote push config could publish local Posse recovery refs:",
        ...riskyPushConfigs.slice(0, 10).map((entry) => `  ${entry.key}=${entry.value}`),
        "Run Posse once to rewrite remote push refspecs, or set remote.<name>.push to HEAD/refs/heads only.",
      ].join("\n"),
    };
  }

  let status = "";
  try {
    status = (await execFileText("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })).trim();
  } catch {
    return { ok: true, output: "" };
  }

  if (status) {
    const relevantStatus = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => {
        const file = _normalizeRepoPath(line.slice(3).trim());
        return !_isRuntimePath(file);
      });
    if (relevantStatus.length > 0) {
      return {
        ok: false,
        output: [
          "Push blocked by pre-push gate.",
          "Working tree is not clean:",
          ...status.split("\n").slice(0, 20),
        ].join("\n"),
      };
    }
  }

  let upstream = "";
  try {
    upstream = (await execFileText("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })).trim();
  } catch { /* no upstream is allowed */ }

  if (upstream) {
    try {
      const names = (await execFileText("git", ["diff", "--name-only", `${upstream}..HEAD`], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })).trim();
      const envFiles = names
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /(^|\/)\.env($|\.)/i.test(line));
      if (envFiles.length > 0) {
        return {
          ok: false,
          output: [
            "Push blocked by pre-push gate.",
            "Unpushed commits include .env-style files:",
            ...envFiles.slice(0, 10).map((file) => `  ${file}`),
          ].join("\n"),
        };
      }

      const diff = await execFileText("git", ["diff", `${upstream}..HEAD`, "--unified=0"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 4,
      });
      const findings = _scanTextForSecrets(diff);
      if (findings.length > 0) {
        return {
          ok: false,
          output: [
            "Push blocked by pre-push gate.",
            "Possible secrets detected in unpushed diff:",
            ...findings.slice(0, 10).map((finding) => `  ${finding}`),
          ].join("\n"),
        };
      }
    } catch { /* best effort */ }
  }

  const verifyCmd = readSettingText("pre_push_verify_cmd");
  if (verifyCmd) {
    try {
      await runHookShellCommandAsync(verifyCmd, { cwd, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
    } catch (err) {
      const raw = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
      return {
        ok: false,
        output: [
          `Push blocked by pre-push verify command (exit ${err.status ?? "?"}).`,
          `Command: ${verifyCmd}`,
          "",
          ...raw.split("\n").slice(-40),
        ].join("\n"),
      };
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
