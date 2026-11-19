import fs from "node:fs";
import path from "node:path";
import { sessionArgumentsForServe } from "../../../../catalog/pairing-command.js";
import { ServedAccess } from "../../../pairing/classes/ServedAccess.js";
import { scrubSecrets } from "../../../../shared/telemetry/classes/logging/secret-scrub.js";
import { Bridge } from "../../../bridge/classes/Bridge.js";
import { getBridgeConfig } from "../../../bridge/functions/auth.js";
import { ServedSession } from "../../../pairing/classes/ServedSession.js";
import { createPairingRemoteClient } from "../../../pairing/functions/remote-client.js";
import { runPairCommand } from "../../../pairing/functions/phone-pairing.js";
import { foregroundCommandRunning } from "../../../pairing/functions/foreground-command.js";
export { runPairCommand } from "../../../pairing/functions/phone-pairing.js";

function hasFlag(argv, flag) { return (argv || []).includes(flag); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Wait until the relay handshake reaches a decisive state. Pairing exists but
 * a silently failing relay link looks identical to "no UX" from the phone, so
 * serve must not print its banner and go quiet while unauthenticated.
 */
async function waitForRelayOutcome(bridge, { timeoutMs = 10_000, pollMs = 250, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const stopped = bridge.stopped?.then(() => ({ state: "stopped" }));
  let status = bridge.relayStatus?.() ?? { state: "disabled" };
  while (Date.now() < deadline) {
    if (signal?.aborted) return { state: "stopped" };
    status = bridge.relayStatus?.() ?? { state: "disabled" };
    if (["online", "unauthorized", "stopped", "disabled"].includes(status.state)) return status;
    const outcome = await (stopped ? Promise.race([sleep(pollMs), stopped]) : sleep(pollMs));
    if (outcome?.state === "stopped") return outcome;
  }
  return status;
}

const SERVE_RESTART_BASE_MS = 1_000;
const SERVE_RESTART_MAX_MS = 30_000;
const SERVE_MAX_RAPID_FAILURES = 5;
// A restart only counts as a recovery once the bridge stays up this long;
// crashes inside the window accumulate strikes toward the exit(1) rail so a
// deterministically recurring crash cannot flap the relay forever.
const SERVE_STABLE_RUN_MS = 60_000;
const SERVE_MAX_CRASH_LOG_BYTES = 5 * 1024 * 1024;
const BENIGN_STREAM_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  // A torn-down controlling tty (window closed, ssh dropped) surfaces as
  // EIO on write. For a long-lived serve that is detachment, not a crash.
  "EIO",
]);

/**
 * Keep the bridge alive across uncaught errors. orchestrator.js installs
 * process-wide fatal handlers that log and exit(1) — the right policy for a
 * batch run, where dying loudly beats a corrupt wrap-up, but fatal for serve:
 * one stray unhandled rejection silently takes the phone/web bridge offline
 * until someone restarts it at the desktop. Serve replaces those handlers
 * (and the orchestrator's stdout/stderr error listeners, which also exit)
 * with a restart guard: record the crash to the same fatal-crashes log, tear
 * the bridge down, and start it again with bounded backoff. Five failures in
 * rapid succession fall back to the old exit(1) so a truly broken
 * environment still dies loudly instead of looping. Ctrl-C and the phone's
 * relay-disable toggle are untouched — this guards crashes only. After
 * release() the handlers stay installed but revert to log-and-exit(1), so
 * shutdown wrap-up keeps the orchestrator's crash observability.
 */
export function installServeCrashGuard(bridge, {
  projectDir = process.cwd(),
  proc = process,
  restartBaseMs = SERVE_RESTART_BASE_MS,
  restartMaxMs = SERVE_RESTART_MAX_MS,
  maxRapidFailures = SERVE_MAX_RAPID_FAILURES,
  stableRunMs = SERVE_STABLE_RUN_MS,
} = {}) {
  let released = false;
  let restarting = false;
  let restartQueued = false;
  let strikes = 0;
  let lastStartAt = Date.now();
  let retryTimer = null;
  let brokenPipeNoted = false;

  const appendCrashLog = (line) => {
    try {
      const dir = path.join(projectDir, ".posse", "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "fatal-crashes.log");
      try {
        if (fs.statSync(file).size > SERVE_MAX_CRASH_LOG_BYTES) return;
      } catch { /* missing file is fine */ }
      fs.appendFileSync(file, line);
    } catch { /* best effort */ }
  };

  const recordCrash = (kind, err) => {
    const stack = err && err.stack ? err.stack : String(err);
    const code = err && err.code ? ` code=${err.code}` : "";
    const line = scrubSecrets(
      `\n[${new Date().toISOString()}] FATAL ${kind}${code} (serve restart guard)\n${stack}\n`,
    );
    try { proc.stderr.write(line); } catch { /* consumer may be gone */ }
    appendCrashLog(line);
  };

  const noteDetachedConsumerOnce = (kind) => {
    if (brokenPipeNoted) return;
    brokenPipeNoted = true;
    appendCrashLog(
      `\n[${new Date().toISOString()}] NOTE broken-pipe swallowed (serve ${kind}) — output consumer detached; bridge continues\n`,
    );
  };

  const strike = (kind, err) => {
    if (restarting) {
      // The bridge is mid-bounce; queue exactly one follow-up so a crash
      // thrown from the fresh bridge's own startup is not silently dropped.
      restartQueued = true;
      return;
    }
    if (retryTimer) return;
    if (Date.now() - lastStartAt >= stableRunMs) strikes = 0;
    strikes += 1;
    if (strikes >= maxRapidFailures) {
      recordCrash(
        "serve_restart_exhausted",
        new Error(`giving up after ${strikes} rapid bridge failures (last: ${kind}: ${err?.message || err})`),
      );
      proc.exit(1);
      return;
    }
    const delay = Math.min(restartMaxMs, restartBaseMs * 2 ** (strikes - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void restart();
    }, delay);
    // Deliberately ref'd: mid-backoff this timer may be the only handle
    // keeping the event loop alive — unref'ing it would let serve exit 0
    // silently instead of retrying.
  };

  const restart = async () => {
    if (released || restarting) return;
    restarting = true;
    restartQueued = false;
    try { await bridge.stop({ restarting: true }); } catch { /* stop() is defensive */ }
    if (released) {
      restarting = false;
      return;
    }
    try {
      await bridge.start({ restarting: true });
      lastStartAt = Date.now();
    } catch (err) {
      restarting = false;
      recordCrash("serve_restart_failed", err);
      strike("serve_restart_failed", err);
      return;
    }
    restarting = false;
    if (released) {
      // Shutdown won the race while start() was in flight; the main path's
      // bridge.stop() may have run against a half-built bridge. Tear the
      // fresh one down so no ref'd server handle outlives "bridge stopped".
      try { await bridge.stop(); } catch { /* best effort */ }
      return;
    }
    if (restartQueued) strike("crash_during_restart", null);
  };

  const onFatal = (kind) => (err) => {
    if (err && BENIGN_STREAM_CODES.has(err.code)) {
      noteDetachedConsumerOnce(kind);
      return;
    }
    recordCrash(kind, err);
    if (released) {
      // Post-shutdown crashes revert to the orchestrator's policy: die
      // loudly with the log entry above instead of resurrecting the bridge.
      proc.exit(1);
      return;
    }
    strike(kind, err);
  };
  const onUncaught = onFatal("uncaughtException");
  const onUnhandled = onFatal("unhandledRejection");
  proc.removeAllListeners?.("uncaughtException");
  proc.removeAllListeners?.("unhandledRejection");
  proc.on("uncaughtException", onUncaught);
  proc.on("unhandledRejection", onUnhandled);

  // Take over the orchestrator's stdout/stderr error listeners too — they
  // exit(1) on any non-broken-pipe write error, and restarting the bridge
  // cannot fix an output stream, so these are log-only.
  const onStreamError = (err) => {
    if (err && BENIGN_STREAM_CODES.has(err.code)) {
      noteDetachedConsumerOnce("stream");
      return;
    }
    recordCrash("stream", err);
  };
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream?.on) continue;
    try {
      stream.removeAllListeners?.("error");
      stream.on("error", onStreamError);
    } catch { /* best effort */ }
  }

  return () => {
    released = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // Handlers stay installed on purpose — see the docblock.
  };
}

function waitForShutdown(stopped = null, abortSignal = null, onShutdown = () => {}) {
  const signals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
  let cleanup = () => {};
  return new Promise((resolve) => {
    let settled = false;
    const done = (signal) => {
      if (settled) return;
      settled = true;
      onShutdown();
      resolve(signal);
    };
    // A Ctrl+C while the session console has handed the terminal to a
    // foreground command (go, add, merge, deploy) is that command's. `on`, not
    // `once`, so the one ignored here does not use up the handler.
    const interrupted = (signal) => {
      if (signal === "SIGINT" && foregroundCommandRunning()) return;
      done(signal);
    };
    cleanup = () => {
      for (const signal of signals) process.off(signal, interrupted);
      abortSignal?.removeEventListener("abort", canceled);
    };
    const canceled = () => done("session closed");
    abortSignal?.addEventListener("abort", canceled, { once: true });
    if (abortSignal?.aborted) canceled();
    for (const signal of signals) process.on(signal, interrupted);
    if (stopped) void stopped.then(done);
  }).finally(() => {
    cleanup();
  });
}

export async function runServeCommand(argv = [], {
  projectDir = process.cwd(),
  C = new Proxy({}, { get: () => "" }),
  wait = true,
  BridgeClass = Bridge,
  // Someone at a terminal can scan the QR and type the phone's code. Bossy
  // runs serve as a service with no terminal, and pairs through its own flow.
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  pair = runPairCommand,
  sessionFactory = (options) => new ServedSession(options),
  remoteClientFactory = createPairingRemoteClient,
  consoleFactory,
  activeSession,
  host,
} = {}) {
  // All session operations share the serve entry; pair/session remain aliases.
  const sessionArgs = sessionArgumentsForServe(argv);
  const { parsePairArgs, runPairingCommand } = await import("../../../pairing/functions/pair-command.js");
  const parsed = parsePairArgs(sessionArgs);
  if (parsed.action !== "host") {
    return runPairingCommand(sessionArgs, { projectDir, C });
  }
  const json = parsed.json;
  const log = (...args) => (json ? console.error : console.log)(...args);
  const emit = (event) => { if (json) console.log(JSON.stringify(event)); };
  const config = getBridgeConfig(projectDir);

  if (hasFlag(argv, "--show-token")) {
    if (json) emit({ ok: true, token: config.token });
    else log(config.token);
    return { ok: true, token: config.token };
  }

  // `--show-lan-token` is the same value as `--show-token` (the local
  // bridge bearer), surfaced under a more descriptive name. Phones that
  // pair over the LAN need this token, separately from the relay bearer.
  if (hasFlag(argv, "--show-lan-token")) {
    log(`\n  ${C.bold}Posse LAN bridge token${C.reset}`);
    log(`  ${C.dim}Use this on the phone when adding a LAN bridge:${C.reset}`);
    log(`  ${C.cyan}${config.token}${C.reset}`);
    log(
      `\n  ${C.dim}Bridge bind:${C.reset} ${C.cyan}http://${config.bindHost}:${config.port || "(auto 7531+)"}${C.reset}`,
    );
    log(`  ${C.dim}Instance:${C.reset} ${config.instanceId}`);
    log(`  ${C.dim}Label:${C.reset} ${config.label}\n`);
    emit({ ok: true, token: config.token, instance_id: config.instanceId });
    return { ok: true, token: config.token, instanceId: config.instanceId };
  }

  return new ServedAccess({
    argv, sessionArgs, projectDir, C, wait, interactive, config, json,
    BridgeClass, pair, sessionFactory, remoteClientFactory, consoleFactory,
    activeSession, host, installCrashGuard: installServeCrashGuard,
    waitForShutdown, waitForRelayOutcome,
  }).run();
}
