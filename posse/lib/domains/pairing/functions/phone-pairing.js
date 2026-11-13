import fs from "node:fs";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "../../../shared/concurrency/functions/abortable.js";
import { requestBridgePair } from "../../bridge/functions/pair-request.js";
import { getBridgeConfig, setBridgeRelayIdentity } from "../../bridge/functions/auth.js";
import { describeServedDeviceCompute } from "./compute-lease.js";
import { getLivePairingState } from "./state.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { resolvePosseKey } from "../../remote/functions/client.js";
import { HeartbeatAuthManager, heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { PulseTokenManager, pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import { parseSessionConsoleLine } from "./session-console.js";

function flagValue(argv = [], flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  const prefix = `${flag}=`;
  const match = argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function bridgePairUrl(relayHttpBase, endpoint) {
  return new URL(`v1/pairing/phone/${endpoint}`, relayHttpBase);
}

function promptForConfirmationCode(
  prompt = "  Enter the 4-character code shown on your phone: ",
  { signal, onCancel } = {},
) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer = "") => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (!rl.closed) rl.close();
      resolve(String(answer || "").trim());
    };
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    // readline owns Ctrl-C while its terminal prompt is active; Node does
    // not emit process SIGINT for that keypress.
    rl.once("SIGINT", () => {
      onCancel?.();
      finish();
    });
    rl.once("close", () => finish());
    if (signal?.aborted) {
      finish();
      return;
    }
    rl.question(prompt, (answer) => finish(answer));
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
  const admission = parseSessionConsoleLine(value);
  return admission.kind === "admit" && admission.computeOwner !== "member"
    ? admission.code
    : String(value || "").trim().toUpperCase();
}

function isValidConfirmationCode(value) {
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(value);
}

function qrExpiresAtMs(expiresAt) {
  const parsed = Date.parse(String(expiresAt || ""));
  return Number.isFinite(parsed) ? parsed : Date.now() + 5 * 60 * 1000;
}

const PAIR_CONFIRM_FRIENDLY = Object.freeze({
  qr_token_invalid: "QR token not recognized. Run `posse serve --pair` again to mint a fresh one.",
  qr_token_expired: "QR expired before you confirmed. Run `posse serve --pair` again.",
  qr_token_already_used: "Another phone already used this QR. Run `posse serve --pair` again to mint a fresh one.",
  confirmation_pending: "The phone has not finished scanning the QR yet. Waiting, then retrying with the same code.",
  confirmation_mismatch: "Confirmation code doesn't match what the phone committed. Try again with the exact code shown on the phone.",
  already_consumed: "This pair was already completed. Run `posse serve --pair` again if you need to pair another instance.",
  pairing_canceled: "This pairing was canceled. Run `posse serve --pair` again to mint a fresh QR.",
});

/**
 * Bridge-initiated pairing flow (3-step mutual confirmation):
 *   1. This CLI calls POST /v1/pairing/phone/start; the relay mints a
 *      short-lived qr_token and returns it.
 *   2. We render `posse://pair?token=<qr_token>` as a terminal QR. The
 *      user scans it with the phone. The phone generates a 4-char
 *      confirmation code, displays it, and commits its hash to the relay
 *      via /v1/pairing/phone/scan.
 *   3. The user types the 4-char code back into this CLI. We call
 *      /v1/pairing/phone/confirm; the relay verifies the code matches and
 *      mints a bridge_token bound to the scanning user's account.
 *
 * --pair-code <code> still works but is renamed to --confirmation-code
 * for clarity; the old flag is accepted as a fallback.
 */
// A paired phone holds the same kind of lease as a session member, always on
// the paired computer; serve says where its work will run. The session state
// is advisory here: a repository with no runtime database has no session, and
// printing this line must never create one or stop serve.
export function servedComputeLine() {
  let state = null;
  try {
    if (fs.existsSync(getRuntimeDbPath())) state = getLivePairingState();
  } catch { /* an unreadable journal reads as no session */ }
  return describeServedDeviceCompute(state);
}

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
    processRef = process,
    cancelTimeoutMs = 2_000,
    requestTimeoutMs = 15_000,
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

  const cancelUrl = bridgePairUrl(pairHttpBase, "cancel");
  let qrToken = null;
  let expiryTimer = null;
  let expiresAt = Infinity;
  let relayConsumed = false;
  let cancelRequested = false;
  const ceremonyAbort = new AbortController();
  const cancellationSignals = processRef.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
  const cancelFromSignal = () => {
    cancelRequested = true;
    ceremonyAbort.abort();
  };
  for (const signal of cancellationSignals) processRef.on?.(signal, cancelFromSignal);

  const cancelRelayPair = async () => {
    try {
      pairPulseTokens.assertTrustedResourceUrl(cancelUrl, "bridge pair cancel");
      const { response: cancelRes, body: cancelBody } = await requestBridgePair(cancelUrl, {
        fetchImpl, authHeaders: pairAuthHeaders, body: { qr_token: qrToken }, timeoutMs: cancelTimeoutMs,
      });
      if (cancelRes.ok || cancelBody?.error?.code === "already_consumed") return;
      const message = cancelBody?.error?.message || cancelBody?.message || `HTTP ${cancelRes.status}`;
      console.log(`  ${C.yellow}Pair cleanup did not complete:${C.reset} ${message}. The QR will expire automatically.\n`);
    } catch (err) {
      console.log(`  ${C.yellow}Pair cleanup did not complete:${C.reset} ${err?.message || err}. The QR will expire automatically.\n`);
    }
  };

  const completePairing = async () => {
    // Step 1: ask the relay to mint a QR token. Cancellation is installed
    // before auth or network work, including on the first request.
    const startUrl = bridgePairUrl(pairHttpBase, "start");
    let startRes;
    let startBody;
    try {
      pairPulseTokens.assertTrustedResourceUrl(startUrl, "bridge pair start");
      ({ response: startRes, body: startBody } = await requestBridgePair(startUrl, {
        fetchImpl, authHeaders: pairAuthHeaders, body: { instance_label: config.label, ...(config.relayToken ? { bridge_token: config.relayToken } : {}) },
        signal: ceremonyAbort.signal, timeoutMs: requestTimeoutMs,
      }));
    } catch (err) {
      if (cancelRequested) throw err;
      console.log(`\n  ${C.red}Network error contacting relay:${C.reset} ${err?.message || err}\n`);
      return { ok: false, reason: "network_error" };
    }
    if (!startRes.ok) {
      const message = startBody?.error?.message || startBody?.message || `HTTP ${startRes.status}`;
      console.log(`\n  ${C.red}Relay rejected pair-start:${C.reset} ${message}\n`);
      return { ok: false, reason: "pair_start_failed", status: startRes.status, body: startBody };
    }
    qrToken = startBody?.qr_token;
    if (!qrToken) {
      console.log(`\n  ${C.red}Relay returned no qr_token.${C.reset}\n`);
      return { ok: false, reason: "missing_qr_token", body: startBody };
    }
    expiresAt = qrExpiresAtMs(startBody?.expires_at);
    expiryTimer = setTimeout(() => ceremonyAbort.abort(), Math.max(0, expiresAt - Date.now()));

    // Step 2: render the QR for the phone to scan.
    const payloadUrl = `posse://pair?token=${encodeURIComponent(qrToken)}`;
    const qrArt = await abortable(renderTerminalQr(payloadUrl), ceremonyAbort.signal);
    console.log("");
    console.log(qrArt);
    console.log(`  ${C.dim}1.${C.reset} On the Posse phone app, tap "Pair an instance" → "Scan QR".`);
    console.log(`  ${C.dim}2.${C.reset} Scan the QR above with your phone's camera.`);
    console.log(`  ${C.dim}3.${C.reset} The phone will display a 4-character confirmation code.`);
    console.log(`  ${C.dim}4.${C.reset} Type that code below (or admit <CODE> host) to finish pairing.\n`);
    // The phone's "Enter token manually" takes the bare token or the
    // posse://pair URL; a camera that cannot read the terminal needs it in text.
    console.log(`  ${C.dim}Can't scan?${C.reset} On the phone tap "Enter token manually" and type this token:`);
    console.log(`  ${C.bold}${qrToken}${C.reset}\n`);
    if (startBody?.expires_at) {
      console.log(`  ${C.dim}QR expires at:${C.reset} ${startBody.expires_at}\n`);
    }

    // Step 3: prompt for the confirmation code (or take it from a flag for scripting).
    const scriptedCode =
      flagValue(argv, "--confirmation-code") || flagValue(argv, "--pair-code") || "";
    const scripted = normalizeConfirmationCode(scriptedCode) !== "";
    let confirmationCode = normalizeConfirmationCode(scriptedCode);
    const confirmUrl = bridgePairUrl(pairHttpBase, "confirm");
    let body;
    let confirmed = false;
    let transientConfirmFailures = 0;

    while (Date.now() < expiresAt || transientConfirmFailures > 0) {
      if (!confirmationCode) {
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => ceremonyAbort.abort(), Math.max(0, expiresAt - Date.now()));
        confirmationCode = normalizeConfirmationCode(await abortable(promptCode(
          "  Enter the 4-character code shown on your phone: ",
          { signal: ceremonyAbort.signal, onCancel: cancelFromSignal },
        ), ceremonyAbort.signal));
        ceremonyAbort.signal.throwIfAborted();
      }
      if (!confirmationCode) {
        console.log(`\n  ${C.red}Pairing cancelled (no confirmation code).${C.reset}\n`);
        return { ok: false, reason: cancelRequested ? "canceled" : "no_confirmation_code" };
      }
      if (!isValidConfirmationCode(confirmationCode)) {
        console.log(`\n  ${C.red}Invalid confirmation code.${C.reset} Use 4 characters A-Z or 2-9, without 0/O/1/I/L.\n`);
        if (scripted) return { ok: false, reason: "invalid_confirmation_code" };
        confirmationCode = "";
        continue;
      }
      if (Date.now() >= expiresAt && transientConfirmFailures === 0) break;

      // QR expiry limits admission, not an already-issued confirmation.
      // Once sent, allow its full response deadline to persist relay success.
      clearTimeout(expiryTimer);
      let confirmRes;
      try {
        pairPulseTokens.assertTrustedResourceUrl(confirmUrl, "bridge pair confirm");
        ({ response: confirmRes, body } = await requestBridgePair(confirmUrl, {
          fetchImpl, authHeaders: pairAuthHeaders,
          body: { qr_token: qrToken, confirmation_code: confirmationCode },
          signal: ceremonyAbort.signal,
          timeoutMs: requestTimeoutMs,
          onResponse: (response) => { if (response.ok) relayConsumed = true; },
        }));
      } catch (err) {
        if (cancelRequested || ceremonyAbort.signal.aborted) throw err;
        transientConfirmFailures += 1;
        if (transientConfirmFailures < Math.max(1, Number(confirmRetryLimit) || 1)) {
          console.log(`\n  ${C.yellow}Relay confirmation response was interrupted; retrying the same pair safely.${C.reset}\n`);
          const remainingMs = expiresAt - Date.now();
          if (remainingMs > 0) await delay(Math.min(retryDelayMs, remainingMs), undefined, { signal: ceremonyAbort.signal });
          continue;
        }
        console.log(`\n  ${C.red}Network error contacting relay:${C.reset} ${err?.message || err}\n`);
        return { ok: false, reason: "network_error" };
      }

      if (confirmRes.ok) {
        confirmed = true;
        break;
      }
      if (confirmRes.status >= 500) {
        transientConfirmFailures += 1;
        if (transientConfirmFailures < Math.max(1, Number(confirmRetryLimit) || 1)) {
          console.log(`\n  ${C.yellow}Relay confirmation failed transiently; retrying the same pair safely.${C.reset}\n`);
          const remainingMs = expiresAt - Date.now();
          if (remainingMs > 0) await delay(Math.min(retryDelayMs, remainingMs), undefined, { signal: ceremonyAbort.signal });
          continue;
        }
      }

      transientConfirmFailures = 0;
      const code = body?.error?.code;
      const message = body?.error?.message || body?.message || `HTTP ${confirmRes.status}`;
      const friendly = PAIR_CONFIRM_FRIENDLY[code] || message;
      if (code === "confirmation_pending") {
        console.log(`\n  ${C.yellow}Pair not confirmed yet:${C.reset} ${friendly}\n`);
        if (scripted) return { ok: false, reason: code, status: confirmRes.status, body };
        const remainingMs = expiresAt - Date.now();
        if (remainingMs > 0) await delay(Math.min(retryDelayMs, remainingMs), undefined, { signal: ceremonyAbort.signal });
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

    const token = typeof body?.bridge_token === "string" ? body.bridge_token.trim()
      : body?.instance?.id === config.instanceId ? config.relayToken || "" : "";
    if (!token) {
      console.log(`\n  ${C.red}Relay accepted code but returned no bridge_token.${C.reset}\n`);
      return { ok: false, reason: "missing_bridge_token", body };
    }
    const instanceId = typeof body?.instance?.id === "string" ? body.instance.id.trim() : "";
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
    console.log(`  ${C.dim}Compute:${C.reset} ${servedComputeLine()}`);
    console.log(`  ${C.dim}Relay identity stored for this repo.${C.reset}`);
    console.log("");
    return { ok: true, paired: true, instance: body.instance };
  };
  let result;
  try {
    result = await completePairing();
  } catch (err) {
    if (cancelRequested) {
      console.log(`\n  ${C.red}Pairing cancelled.${C.reset}\n`);
      result = { ok: false, reason: "canceled" };
    } else if (Date.now() >= expiresAt) {
      console.log(`\n  ${C.red}QR expired before pairing completed.${C.reset} Run \`posse serve --pair\` again.\n`);
      result = { ok: false, reason: "qr_token_expired" };
    } else {
      throw err;
    }
  } finally {
    clearTimeout(expiryTimer);
    try {
      if (qrToken && !relayConsumed) await cancelRelayPair();
    } finally {
      for (const signal of cancellationSignals) processRef.off?.(signal, cancelFromSignal);
    }
  }
  // Cleanup is bounded but asynchronous. A stop received during that wait
  // must not turn an earlier Enter/skip result into permission to serve.
  return cancelRequested ? { ok: false, reason: "canceled" } : result;
}

