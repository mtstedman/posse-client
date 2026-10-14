// @ts-check

import { spawn, spawnSync } from "child_process";
import { buildWindowsSpawn } from "../../../providers/functions/shared/windows-spawn.js";
import { parseCommandArguments } from "../../../../shared/scope/functions/test-command.js";
import { TEST_SUBPROCESS_ENV_KEYS, VERIFICATION_PULSE_CAPABILITY_ENV } from "../../../../catalog/process.js";
import { parentSecretValues, redactExactValues } from "../../../../shared/platform/functions/subprocess-output.js";
import { filterProcessEnv } from "../../../../shared/platform/functions/process-env.js";
import { testCommandCapability } from "../../../verification/functions/test-capability.js";
import { TEST_CAPABILITY_PRUNED_REASON, TEST_RUNNER_REMOVED_REASON } from "../../../../catalog/verification.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

export const MAX_STREAM_CHARS = 256 * 1024;

export const DEFAULT_TIMEOUT_MS = 120_000;

export const TERMINATION_GRACE_MS = 250;

export const TERMINATION_SETTLE_MS = 5_000;

export function appendBounded(current, chunk, maxChars = MAX_STREAM_CHARS) {
  const next = current + String(chunk || "");
  if (next.length <= maxChars) return { value: next, truncated: false };
  return {
    value: next.slice(next.length - maxChars),
    truncated: true,
  };
}

export function killProcessTree(child, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  force = false,
} = {}) {
  if (platform !== "win32" && child?.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      // Fall through to killing the direct child.
    }
  }
  if (platform === "win32" && child?.pid) {
    try {
      const result = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result?.status === 0) return true;
    } catch {
      // Fall through to the shell wrapper.
    }
  }
  try {
    return !!child?.kill?.(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}

/** @param {string} command
 * @param {{cwd?: string, timeoutMs?: number, idleTimeoutMs?: number, trustedShell?: boolean, signal?: AbortSignal, baselineCommit?: string}} options
 */
export async function runCommand(command, {
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs = null,
  trustedShell = false,
  signal: abortSignal = null,
  baselineCommit = "HEAD",
} = {}) {
  abortSignal?.throwIfAborted();
  const unavailable = !trustedShell && testCommandCapability(command, cwd, { baselineCommit });
  if (unavailable === TEST_RUNNER_REMOVED_REASON) {
    return { status: "failed", ok: false, code: 1, signal: null, timed_out: false,
      duration_ms: 0, stdout: "", stderr: "The candidate removed a test script present at its verification baseline.",
      stdout_truncated: false, stderr_truncated: false, timeout_kind: null, reason: unavailable };
  }
  if (unavailable) {
    log.warn("verification", "Pruned unavailable test execution", { command, cwd, reason: unavailable });
    return { status: "skipped", ok: null, code: null, signal: null, timed_out: false,
      duration_ms: 0, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false,
      timeout_kind: null, reason: TEST_CAPABILITY_PRUNED_REASON, capability_reason: unavailable };
  }
  const startedAt = Date.now();
  const idleLimitMs = Number(idleTimeoutMs) > 0 ? Math.max(1000, Number(idleTimeoutMs)) : null;
  let pulseBroker = null;
  try {
    const { startVerificationPulseBrokerIfAvailable } = await import(
      "../../../../shared/native/classes/VerificationPulseBroker.js"
    );
    pulseBroker = await startVerificationPulseBrokerIfAvailable();
  } catch (error) {
    return {
      status: "infrastructure_error",
      ok: null,
      code: (/** @type {NodeJS.ErrnoException} */ (error))?.code ?? null,
      signal: null,
      timed_out: false,
      duration_ms: Date.now() - startedAt,
      stdout: "",
      stderr: error?.message || String(error),
      stdout_truncated: false,
      stderr_truncated: false,
      timeout_kind: null,
      reason: "verification_capability_broker_unavailable",
    };
  }
  if (abortSignal?.aborted) {
    await pulseBroker?.close();
    abortSignal.throwIfAborted();
  }
  const result = await new Promise((resolve) => {
    let child;
    const env = filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS });
    if (pulseBroker) env[VERIFICATION_PULSE_CAPABILITY_ENV] = JSON.stringify(pulseBroker.capability());
    const secrets = [
      ...parentSecretValues(process.env),
      ...(pulseBroker?.token ? [pulseBroker.token] : []),
    ];
    const resolveAfterBrokerClose = (result) => {
      if (!pulseBroker) {
        resolve(result);
        return;
      }
      void pulseBroker.close().then(
        () => resolve(result),
        () => resolve(result),
      );
    };
    try {
      if (trustedShell) {
        child = spawn(command, {
          cwd,
          detached: process.platform !== "win32",
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      } else {
        const [executable, ...args] = parseCommandArguments(command);
        const invocation = buildWindowsSpawn(executable, args);
        child = spawn(invocation.command, invocation.args, {
          cwd,
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      }
    } catch (error) {
      resolveAfterBrokerClose({
        status: "infrastructure_error",
        ok: null,
        code: (/** @type {NodeJS.ErrnoException} */ (error))?.code ?? null,
        signal: null,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
        stdout: "",
        stderr: error?.message || String(error),
        stdout_truncated: false,
        stderr_truncated: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let timeoutKind = null;
    let forceTimer = null;
    let settleTimer = null;
    let idleTimer = null;

    const finish = ({
      code = null,
      error = null,
      signal = null,
      timedOut = false,
    } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", cancel);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (idleTimer) clearTimeout(idleTimer);
      const status = timedOut
        ? "timed_out"
        : error || signal
          ? "infrastructure_error"
          : code === 0 && !error
            ? "passed"
            : "failed";
      resolveAfterBrokerClose({
        status,
        ok: status === "passed" ? true : (status === "infrastructure_error" ? null : false),
        code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: redactExactValues(stdout, secrets),
        stderr: error
          ? redactExactValues([stderr, error.message || String(error)].filter(Boolean).join("\n"), secrets)
          : redactExactValues(stderr, secrets),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timeout_kind: timedOut ? timeoutKind : null,
        reason: signal && !timedOut
          ? `test_runner_terminated:${signal}`
          : error
          ? `test_runner_spawn_failed:${error.code || "unknown"}`
          : timedOut && timeoutKind === "idle"
            ? "test_idle_timeout"
            : null,
      });
    };

    const terminate = (kind) => {
      if (timedOut || settled) return;
      timedOut = true;
      timeoutKind = kind;
      if (idleTimer) clearTimeout(idleTimer);
      killProcessTree(child);
      forceTimer = setTimeout(() => killProcessTree(child, { force: true }), TERMINATION_GRACE_MS);
      forceTimer.unref?.();
      settleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish({
          code: 124,
          timedOut: true,
          error: Object.assign(new Error("Timed-out test process tree did not report exit after forced termination."), { code: "ETIMEDOUT" }),
        });
      }, TERMINATION_SETTLE_MS);
      settleTimer.unref?.();
    };

    const cancel = () => terminate("canceled");
    const timer = setTimeout(() => terminate("wall"), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    // The idle limit restarts on every byte of output. A harness that is
    // silent while healthy must leave it disabled (see verification-policy.js).
    const armIdle = () => {
      if (!idleLimitMs || timedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate("idle"), idleLimitMs);
    };
    armIdle();

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      armIdle();
      const bounded = appendBounded(stdout, chunk);
      stdout = bounded.value;
      stdoutTruncated = stdoutTruncated || bounded.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      armIdle();
      const bounded = appendBounded(stderr, chunk);
      stderr = bounded.value;
      stderrTruncated = stderrTruncated || bounded.truncated;
    });
    child.on("error", (error) => finish({ code: (/** @type {NodeJS.ErrnoException} */ (error))?.code ?? null, error, timedOut }));
    child.on("close", (code, signal) => finish({ code: timedOut ? 124 : code, signal, timedOut }));
    abortSignal?.addEventListener("abort", cancel, { once: true });
    if (abortSignal?.aborted) cancel();
  });
  abortSignal?.throwIfAborted();
  return result;
}
