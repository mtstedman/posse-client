import { spawn, spawnSync } from "child_process";
import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { buildWindowsSpawn } from "../shared/windows-spawn.js";
import { InteractiveCliSession, InteractiveCliUnavailableError } from "../../classes/InteractiveCliSession.js";
import { getDefaultInteractiveCliBackend, stripTerminalControls } from "../shared/interactive-cli-session.js";
import { getClaudeConfigDir, hasUsableClaudeOauthToken, readClaudeCredentials } from "./auth-state.js";
import { getClaudeCommand, getClaudeCommandAsync } from "./cli-discovery.js";
import { classifyClaudeCliFailure } from "./failure-classification.js";

function normalizeClaudeOauthWarmupResult(result = {}) {
  const status = Number.isFinite(result.status) ? result.status : null;
  const signal = result.signal || null;
  const error = result.error ? String(result.error.message || result.error) : null;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const failure = classifyClaudeCliFailure({ error, stdout, stderr });
  return {
    attempted: true,
    ok: !error && status === 0,
    status,
    signal,
    error,
    stdout,
    stderr,
    classification: failure?.classification || null,
    retryable: failure?.retryable ?? null,
    detail: failure?.detail || null,
  };
}

function normalizeClaudeOauthWarmupError(err, { skipped = null } = {}) {
  const failure = classifyClaudeCliFailure(err);
  return {
    attempted: !skipped,
    ok: false,
    skipped,
    status: null,
    signal: null,
    error: String(err?.message || err || "warmup failed"),
    stdout: "",
    stderr: "",
    classification: failure?.classification || null,
    retryable: failure?.retryable ?? null,
    detail: failure?.detail || null,
  };
}

async function runClaudeWarmupViaInteractiveCli({
  cwd = null,
  timeoutMs = 20_000,
  backend = null,
} = {}) {
  const resolvedBackend = backend || getDefaultInteractiveCliBackend();
  if (!resolvedBackend) throw new InteractiveCliUnavailableError();
  const resolvedClaude = await getClaudeCommandAsync();
  const session = new InteractiveCliSession({
    command: resolvedClaude.command,
    args: resolvedClaude.args,
    cwd: cwd || process.cwd(),
    env: process.env,
    backend: resolvedBackend,
    timeoutMs,
    quietMs: 500,
    cols: 120,
    rows: 40,
  });

  try {
    session.start();
    await session.waitForQuiet({ quietMs: 300, timeoutMs: Math.min(timeoutMs, 2_000) }).catch(() => {});
    session.sendLine("Reply with OK.");
    await session.waitFor(
      (output) => /\bOK\b/i.test(stripTerminalControls(output)),
      { timeoutMs }
    );
    await session.waitForQuiet({ quietMs: 500, timeoutMs: Math.min(timeoutMs, 3_000) }).catch(() => {});
    session.sendLine("/exit");
    return {
      status: 0,
      signal: null,
      error: null,
      stdout: session.cleanTranscript(),
      stderr: "",
    };
  } finally {
    await session.close({ gracefulMs: 500 });
  }
}

export function warmOauthSession({ cwd = null, timeoutMs = 20_000 } = {}) {
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  let resolvedClaude;
  try {
    resolvedClaude = getClaudeCommand();
  } catch (err) {
    if (err?.code === "CLAUDE_CLI_NOT_FOUND") {
      return {
        attempted: false,
        ok: false,
        skipped: "claude-cli-unavailable",
        error: err.message,
      };
    }
    throw err;
  }
  const prompt = "Reply with OK.";
  const invoke = typeof globalThis.__posseWarmClaudeOauthSession === "function"
    ? globalThis.__posseWarmClaudeOauthSession
    : ({ resolvedCwd, resolvedTimeoutMs }) => {
      const launch = buildWindowsSpawn(resolvedClaude.command, [...resolvedClaude.args, "-p", "--max-turns", "1", "--output-format", "text"]);
      return spawnSync(
        launch.command,
        launch.args,
        {
          cwd: resolvedCwd,
          input: prompt,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          timeout: resolvedTimeoutMs,
        }
      );
    };

  try {
    const result = invoke({
      resolvedCwd: cwd || process.cwd(),
      resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
    }) || {};
    return normalizeClaudeOauthWarmupResult(result);
  } catch (err) {
    return normalizeClaudeOauthWarmupError(err);
  }
}

function spawnClaudeWarmupAsync({ resolvedCwd, resolvedTimeoutMs, prompt }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const resolvedClaude = getClaudeCommand();
    const launch = buildWindowsSpawn(resolvedClaude.command, [...resolvedClaude.args, "-p", "--max-turns", "1", "--output-format", "text"]);
    const child = spawn(
      launch.command,
      launch.args,
      {
        cwd: resolvedCwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ status: null, signal: "SIGTERM", error: new Error("Claude OAuth warmup timed out") });
    }, resolvedTimeoutMs);
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout = appendBoundedText(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBoundedText(stderr, chunk); });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("exit", (status, signal) => finish({ status, signal: signal || null, error: null }));
    child.stdin?.end(prompt);
  });
}

export async function warmOauthSessionInteractive({ cwd = null, timeoutMs = 20_000, interactiveBackend = null } = {}) {
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  try {
    const result = await runClaudeWarmupViaInteractiveCli({
      cwd,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
      backend: interactiveBackend,
    });
    return normalizeClaudeOauthWarmupResult(result);
  } catch (err) {
    const unavailable = err instanceof InteractiveCliUnavailableError || err?.code === "INTERACTIVE_CLI_UNAVAILABLE";
    return normalizeClaudeOauthWarmupError(err, {
      skipped: unavailable ? "interactive-cli-unavailable" : null,
    });
  }
}

export async function warmOauthSessionAsync({
  cwd = null,
  timeoutMs = 20_000,
  preferInteractive = false,
  interactiveBackend = null,
} = {}) {
  if (preferInteractive || interactiveBackend) {
    const interactive = await warmOauthSessionInteractive({ cwd, timeoutMs, interactiveBackend });
    if (interactive.attempted || interactiveBackend || interactive.skipped !== "interactive-cli-unavailable") {
      return interactive;
    }
  }
  const configDir = getClaudeConfigDir();
  const credentials = readClaudeCredentials(configDir);
  if (!hasUsableClaudeOauthToken(credentials)) {
    return {
      attempted: false,
      ok: false,
      skipped: "oauth-unconfigured",
    };
  }

  try {
    await getClaudeCommandAsync();
  } catch (err) {
    if (err?.code === "CLAUDE_CLI_NOT_FOUND") {
      return {
        attempted: false,
        ok: false,
        skipped: "claude-cli-unavailable",
        error: err.message,
      };
    }
    throw err;
  }
  try {
    const prompt = "Reply with OK.";
    const result = typeof globalThis.__posseWarmClaudeOauthSessionAsync === "function"
      ? await globalThis.__posseWarmClaudeOauthSessionAsync({
        resolvedCwd: cwd || process.cwd(),
        resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
      })
      : await spawnClaudeWarmupAsync({
        resolvedCwd: cwd || process.cwd(),
        resolvedTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000,
        prompt,
      });
    return normalizeClaudeOauthWarmupResult(result || {});
  } catch (err) {
    return normalizeClaudeOauthWarmupError(err);
  }
}

export const __testRunClaudeWarmupViaInteractiveCli = runClaudeWarmupViaInteractiveCli;

