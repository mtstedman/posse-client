import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { scrubSecrets } from "../../../../shared/telemetry/classes/logging/secret-scrub.js";
import { Bridge } from "../../../bridge/classes/Bridge.js";
import {
  getBridgeConfig,
  setBridgeRelayIdentity,
} from "../../../bridge/functions/auth.js";
import { listAllowedBridgeCommands } from "../../../bridge/functions/command-dispatch.js";
import { resolvePosseKey } from "../../../remote/functions/client.js";
import {
  HeartbeatAuthManager,
  heartbeatAuthManager,
} from "../../../../shared/native/classes/HeartbeatAuthManager.js";
import {
  PulseTokenManager,
  pulseTokenManager,
} from "../../../../shared/native/classes/PulseTokenManager.js";

function hasFlag(argv, flag) {
  return (argv || []).includes(flag);
}

function flagValue(argv = [], flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  const prefix = `${flag}=`;
  const match = argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function bridgePairUrl(relayHttpBase, endpoint) {
  return new URL(`v1/bridge-pair/${endpoint}`, relayHttpBase);
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function promptForConfirmationCode(prompt = "  Enter the 4-character code shown on your phone: ") {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function renderTerminalQr(payloadUrl) {
  const mod = await import("qrcode-terminal");
  const qrcode = /** @type {any} */ (mod?.default ?? mod);
  return new Promise((resolve) => {
    qrcode.generate(payloadUrl, { small: true }, (qrString) => {
      resolve(qrString);
    });
  });
}

function normalizeConfirmationCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidConfirmationCode(value) {
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(value);
}

function qrExpiresAtMs(expiresAt) {
  const parsed = Date.parse(String(expiresAt || ""));
  return Number.isFinite(parsed) ? parsed : Date.now() + 5 * 60 * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

const PAIR_CONFIRM_FRIENDLY = Object.freeze({
  qr_token_invalid: "QR token not recognized. Run `posse serve --pair` again to mint a fresh one.",
  qr_token_expired: "QR expired before you confirmed. Run `posse serve --pair` again.",
  qr_token_already_used: "Another phone already used this QR. Run `posse serve --pair` again to mint a fresh one.",
  confirmation_pending: "The phone has not finished scanning the QR yet. Waiting, then retrying with the same code.",
  confirmation_mismatch: "Confirmation code doesn't match what the phone committed. Try again with the exact code shown on the phone.",
  already_consumed: "This pair was already completed. Run `posse serve --pair` again if you need to pair another instance.",
});

/**
 * Bridge-initiated pairing flow (3-step mutual confirmation):
 *   1. This CLI calls POST /v1/bridge-pair/start; the relay mints a
 *      short-lived qr_token and returns it.
 *   2. We render `posse://pair?token=<qr_token>` as a terminal QR. The
 *      user scans it with the phone. The phone generates a 4-char
 *      confirmation code, displays it, and commits its hash to the relay
 *      via /v1/bridge-pair/scan.
 *   3. The user types the 4-char code back into this CLI. We call
 *      /v1/bridge-pair/confirm; the relay verifies the code matches and
 *      mints a bridge_token bound to the scanning user's account.
 *
 * --pair-code <code> still works but is renamed to --confirmation-code
 * for clarity; the old flag is accepted as a fallback.
 */
export async function runPairCommand(
  config,
  {
    C = new Proxy({}, { get: () => "" }),
    argv = [],
    promptCode = promptForConfirmationCode,
    retryDelayMs = 2_000,
    confirmRetryLimit = 3,
    posseKey = undefined,
    authManager = null,
    pulseTokens = null,
    fetchImpl = globalThis.fetch,
    projectDir = process.cwd(),
  } = {},
) {
  const resolvedPosseKey = posseKey === undefined ? resolvePosseKey() : String(posseKey || "").trim();
  const scopedAuthManager = authManager || (
    posseKey === undefined ? heartbeatAuthManager : new HeartbeatAuthManager({ posseKey: resolvedPosseKey })
  );
  const pairPulseTokens = pulseTokens || (
    scopedAuthManager === heartbeatAuthManager && fetchImpl === globalThis.fetch
      ? pulseTokenManager
      : new PulseTokenManager({ authManager: scopedAuthManager, fetchImpl })
  );
  const trustedPolicy = scopedAuthManager.getTrustedAuthPolicy?.();
  const pairHttpBase = trustedPolicy?.origin ? new URL("/", trustedPolicy.origin) : null;

  console.log(`\n  ${C.bold}Pair this Posse instance${C.reset}`);

  // Pairing requires a valid API key (bridge:pair grant) — the relay
  // refuses to mint or confirm QR tokens for keyless installs.
  if (!resolvedPosseKey) {
    console.log(`\n  ${C.red}POSSE_KEY is required to pair.${C.reset} Set the POSSE_KEY environment variable to your API key and run \`posse serve --pair\` again.\n`);
    return { ok: false, reason: "missing_posse_key" };
  }
  if (!pairHttpBase) {
    console.log(`\n  ${C.red}Pairing authentication is unavailable.${C.reset} Trusted remote API policy could not be resolved.\n`);
    return { ok: false, reason: "pair_auth_unavailable" };
  }

  const pairAuthHeaders = async () => {
    const pulse = await pairPulseTokens.getPulseToken({ requiredRoute: "bridge:pair" });
    if (!pulse) throw new Error("pairing authentication is unavailable");
    return {
      "content-type": "application/json",
      authorization: `Bearer ${pulse}`,
    };
  };

  // Step 1: ask the relay to mint a QR token.
  const startUrl = bridgePairUrl(pairHttpBase, "start");
  let startRes;
  try {
    pairPulseTokens.assertTrustedResourceUrl(startUrl, "bridge pair start");
    startRes = await fetchImpl(startUrl, {
      method: "POST",
      headers: await pairAuthHeaders(),
      body: JSON.stringify({ instance_label: config.label }),
      redirect: "error",
    });
  } catch (err) {
    console.log(`\n  ${C.red}Network error contacting relay:${C.reset} ${err?.message || err}\n`);
    return { ok: false, reason: "network_error" };
  }
  const startBody = await readJsonResponse(startRes);
  if (!startRes.ok) {
    const message =
      startBody?.error?.message || startBody?.message || `HTTP ${startRes.status}`;
    console.log(`\n  ${C.red}Relay rejected pair-start:${C.reset} ${message}\n`);
    return { ok: false, reason: "pair_start_failed", status: startRes.status, body: startBody };
  }
  const qrToken = startBody?.qr_token;
  if (!qrToken) {
    console.log(`\n  ${C.red}Relay returned no qr_token.${C.reset}\n`);
    return { ok: false, reason: "missing_qr_token", body: startBody };
  }

  // Step 2: render the QR for the phone to scan.
  const payloadUrl = `posse://pair?token=${encodeURIComponent(qrToken)}`;
  const qrArt = await renderTerminalQr(payloadUrl);
  console.log("");
  console.log(qrArt);
  console.log(`  ${C.dim}1.${C.reset} On the Posse phone app, tap "Pair an instance" → "Scan QR".`);
  console.log(`  ${C.dim}2.${C.reset} Scan the QR above with your phone's camera.`);
  console.log(`  ${C.dim}3.${C.reset} The phone will display a 4-character confirmation code.`);
  console.log(`  ${C.dim}4.${C.reset} Type that code below to finish pairing.\n`);
  if (startBody?.expires_at) {
    console.log(`  ${C.dim}QR expires at:${C.reset} ${startBody.expires_at}\n`);
  }

  // Step 3: prompt for the confirmation code (or take it from a flag for scripting).
  const scriptedCode =
    flagValue(argv, "--confirmation-code") || flagValue(argv, "--pair-code") || "";
  const scripted = normalizeConfirmationCode(scriptedCode) !== "";
  let confirmationCode = normalizeConfirmationCode(scriptedCode);
  const confirmUrl = bridgePairUrl(pairHttpBase, "confirm");
  const expiresAt = qrExpiresAtMs(startBody?.expires_at);
  let body;
  let confirmed = false;
  let transientConfirmFailures = 0;

  while (Date.now() < expiresAt) {
    if (!confirmationCode) confirmationCode = normalizeConfirmationCode(await promptCode());
    if (!confirmationCode) {
      console.log(`\n  ${C.red}Pairing cancelled (no confirmation code).${C.reset}\n`);
      return { ok: false, reason: "no_confirmation_code" };
    }
    if (!isValidConfirmationCode(confirmationCode)) {
      console.log(`\n  ${C.red}Invalid confirmation code.${C.reset} Use 4 characters A-Z or 2-9, without 0/O/1/I/L.\n`);
      if (scripted) return { ok: false, reason: "invalid_confirmation_code" };
      confirmationCode = "";
      continue;
    }
    if (Date.now() >= expiresAt) break;

    let confirmRes;
    try {
      pairPulseTokens.assertTrustedResourceUrl(confirmUrl, "bridge pair confirm");
      confirmRes = await fetchImpl(confirmUrl, {
        method: "POST",
        headers: await pairAuthHeaders(),
        body: JSON.stringify({
          qr_token: qrToken,
          confirmation_code: confirmationCode,
        }),
        redirect: "error",
      });
    } catch (err) {
      transientConfirmFailures += 1;
      if (transientConfirmFailures < Math.max(1, Number(confirmRetryLimit) || 1)) {
        console.log(`\n  ${C.yellow}Relay confirmation response was interrupted; retrying the same pair safely.${C.reset}\n`);
        const remainingMs = expiresAt - Date.now();
        if (remainingMs > 0) await sleep(Math.min(retryDelayMs, remainingMs));
        continue;
      }
      console.log(`\n  ${C.red}Network error contacting relay:${C.reset} ${err?.message || err}\n`);
      return { ok: false, reason: "network_error" };
    }

    body = await readJsonResponse(confirmRes);
    if (confirmRes.ok) {
      confirmed = true;
      break;
    }
    if (confirmRes.status >= 500) {
      transientConfirmFailures += 1;
      if (transientConfirmFailures < Math.max(1, Number(confirmRetryLimit) || 1)) {
        console.log(`\n  ${C.yellow}Relay confirmation failed transiently; retrying the same pair safely.${C.reset}\n`);
        const remainingMs = expiresAt - Date.now();
        if (remainingMs > 0) await sleep(Math.min(retryDelayMs, remainingMs));
        continue;
      }
    }

    const code = body?.error?.code;
    const message = body?.error?.message || body?.message || `HTTP ${confirmRes.status}`;
    const friendly = PAIR_CONFIRM_FRIENDLY[code] || message;
    if (code === "confirmation_pending") {
      console.log(`\n  ${C.yellow}Pair not confirmed yet:${C.reset} ${friendly}\n`);
      if (scripted) return { ok: false, reason: code, status: confirmRes.status, body };
      const remainingMs = expiresAt - Date.now();
      if (remainingMs > 0) await sleep(Math.min(retryDelayMs, remainingMs));
      continue;
    }
    if (code === "confirmation_mismatch") {
      console.log(`\n  ${C.yellow}Pair not confirmed yet:${C.reset} ${friendly}\n`);
      if (scripted) return { ok: false, reason: code, status: confirmRes.status, body };
      confirmationCode = "";
      continue;
    }
    console.log(`\n  ${C.red}Pair failed:${C.reset} ${friendly}\n`);
    return { ok: false, reason: code || "pair_failed", status: confirmRes.status, body };
  }

  if (!confirmed) {
    console.log(`\n  ${C.red}QR expired before pairing completed.${C.reset} Run \`posse serve --pair\` again.\n`);
    return { ok: false, reason: "qr_token_expired" };
  }

  const token = body?.bridge_token;
  if (!token) {
    console.log(`\n  ${C.red}Relay accepted code but returned no bridge_token.${C.reset}\n`);
    return { ok: false, reason: "missing_bridge_token", body };
  }
  const instanceId = String(body?.instance?.id || "").trim();
  if (!instanceId) {
    console.log(`\n  ${C.red}Relay accepted code but returned no instance id.${C.reset}\n`);
    return { ok: false, reason: "missing_instance_id", body };
  }

  const instanceLabel = body?.instance?.label || config.label;
  // Repo-scoped: adopt the relay-minted identity as one unit. Keeping the
  // pre-pair local UUID here makes the socket authenticate successfully but
  // causes every event to be rejected by the relay as instance_mismatch.
  // The relay has already committed the pair at this point, so a persist
  // failure here silently strands the repo as "paired but never online" —
  // verify the write landed before claiming success.
  try {
    setBridgeRelayIdentity(
      { instanceId, label: instanceLabel, token },
      projectDir,
    );
  } catch (err) {
    console.log(`\n  ${C.red}Pair confirmed on the relay but storing the identity locally FAILED:${C.reset} ${err?.message || err}`);
    console.log(`  ${C.dim}Nothing was persisted — this repo will look paired on the phone but stay offline.`);
    console.log(`  Retry \`posse serve --pair\` before the QR expires (the same confirm is replay-safe), or after expiry re-pair from scratch.${C.reset}\n`);
    return { ok: false, reason: "persist_failed", error: err?.message || String(err) };
  }
  const persisted = getBridgeConfig(projectDir);
  if (!persisted.relayToken || persisted.instanceId !== instanceId) {
    console.log(`\n  ${C.red}Pair confirmed on the relay but the stored identity does not read back.${C.reset}`);
    console.log(`  ${C.dim}Expected instance ${instanceId}; read ${persisted.instanceId || "nothing"} (token ${persisted.relayToken ? "present" : "missing"}).`);
    console.log(`  Re-run \`posse serve --pair\` — the phone-side pairing already exists and will be replaced.${C.reset}\n`);
    return { ok: false, reason: "persist_verify_failed" };
  }
  console.log(`  ${C.green}Paired.${C.reset}`);
  console.log(`  ${C.dim}Instance:${C.reset} ${instanceLabel} (${instanceId})`);
  console.log(`  ${C.dim}Relay identity stored for this repo.${C.reset}`);
  console.log(`  ${C.dim}Next:${C.reset} run \`posse serve\`, or enable the bridge from Bossy's Remote tab.\n`);
  return { ok: true, paired: true, instance: body.instance };
}

/**
 * Wait until the relay handshake reaches a decisive state. Pairing exists but
 * a silently failing relay link looks identical to "no UX" from the phone, so
 * serve must not print its banner and go quiet while unauthenticated.
 */
async function waitForRelayOutcome(bridge, timeoutMs = 10_000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let status = bridge.relayStatus?.() ?? { state: "disabled" };
  while (Date.now() < deadline) {
    status = bridge.relayStatus?.() ?? { state: "disabled" };
    if (status.state === "online" || status.state === "unauthorized") return status;
    await sleep(pollMs);
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
    try { await bridge.stop(); } catch { /* stop() is defensive */ }
    if (released) {
      restarting = false;
      return;
    }
    try {
      await bridge.start();
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

function waitForShutdown() {
  const signals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
  let cleanup = () => {};
  return new Promise((resolve) => {
    const done = (signal) => resolve(signal);
    cleanup = () => {
      for (const signal of signals) process.off(signal, done);
    };
    for (const signal of signals) process.once(signal, done);
  }).finally(() => {
    cleanup();
  });
}

export async function runServeCommand(argv = [], {
  projectDir = process.cwd(),
  C = new Proxy({}, { get: () => "" }),
  wait = true,
  BridgeClass = Bridge,
} = {}) {
  const config = getBridgeConfig(projectDir);

  if (hasFlag(argv, "--pair")) {
    const result = await runPairCommand(config, { C, argv, projectDir });
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  if (hasFlag(argv, "--show-token")) {
    console.log(config.token);
    return { ok: true, token: config.token };
  }

  // `--show-lan-token` is the same value as `--show-token` (the local
  // bridge bearer), surfaced under a more descriptive name. Phones that
  // pair over the LAN need this token, separately from the relay bearer.
  if (hasFlag(argv, "--show-lan-token")) {
    console.log(`\n  ${C.bold}Posse LAN bridge token${C.reset}`);
    console.log(`  ${C.dim}Use this on the phone when adding a LAN bridge:${C.reset}`);
    console.log(`  ${C.cyan}${config.token}${C.reset}`);
    console.log(
      `\n  ${C.dim}Bridge bind:${C.reset} ${C.cyan}http://${config.bindHost}:${config.port || "(auto 7531+)"}${C.reset}`,
    );
    console.log(`  ${C.dim}Instance:${C.reset} ${config.instanceId}`);
    console.log(`  ${C.dim}Label:${C.reset} ${config.label}\n`);
    return { ok: true, token: config.token, instanceId: config.instanceId };
  }

  const bridge = new BridgeClass({ projectDir, config });
  const info = await bridge.start();
  console.log(`\n  ${C.green}Posse bridge listening${C.reset}: ${C.cyan}${info.url}${C.reset}`);
  console.log(`  ${C.dim}Instance:${C.reset} ${info.instanceId}`);
  console.log(`  ${C.dim}Label:${C.reset} ${info.label}`);
  console.log(`  ${C.dim}Bearer token:${C.reset} hidden (use --show-token or --show-lan-token)`);
  console.log(`  ${C.dim}WebSocket:${C.reset} ${info.url}/v1/stream`);
  if (info.relayEnabled) console.log(`  ${C.dim}Relay:${C.reset} ${info.relayUrl}`);
  console.log(`  ${C.dim}Commands:${C.reset} ${listAllowedBridgeCommands().join(", ")}`);
  console.log(`  ${C.dim}Press Ctrl-C to stop.${C.reset}\n`);

  // Remote reachability is the whole point of serve — never go quiet while
  // the relay link is missing or rejected.
  if (!info.relayEnabled) {
    console.log(`  ${C.yellow}NOT PAIRED with the relay.${C.reset} Phones and the web portal cannot see this repo.`);
    console.log(`  ${C.dim}Run \`posse serve --pair\` to pair it, then start serve again. LAN-only clients still work.${C.reset}\n`);
  } else if (wait) {
    const relay = await waitForRelayOutcome(bridge);
    if (relay.state === "online") {
      console.log(`  ${C.green}Relay connected${C.reset} — this repo is ONLINE for phones and the web portal.\n`);
    } else if (relay.state === "unauthorized") {
      console.log(`  ${C.red}Relay REJECTED this bridge credential${relay.last_error ? ` (${relay.last_error})` : ""}.${C.reset}`);
      console.log(`  ${C.dim}The pairing is stale or revoked — run \`posse serve --pair\` to re-pair.${C.reset}\n`);
    } else {
      console.log(`  ${C.yellow}Relay not connected yet${C.reset} (${relay.state}${relay.last_error ? ` — ${relay.last_error}` : ""}). Retrying in the background; phones see this repo as offline until it connects.\n`);
    }
  }

  if (!wait) return { ok: true, bridge, info };

  const releaseCrashGuard = installServeCrashGuard(bridge, { projectDir });
  const signal = await waitForShutdown();
  releaseCrashGuard();
  await bridge.stop();
  console.log(`\n  ${C.yellow}Posse bridge stopped${signal ? ` (${signal})` : ""}.${C.reset}\n`);
  return { ok: true, signal };
}
