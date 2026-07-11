import readline from "node:readline";

import { Bridge } from "../../../bridge/classes/Bridge.js";
import {
  getBridgeConfig,
  setBridgeRelayToken,
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
      console.log(`\n  ${C.red}Network error contacting relay:${C.reset} ${err?.message || err}\n`);
      return { ok: false, reason: "network_error" };
    }

    body = await readJsonResponse(confirmRes);
    if (confirmRes.ok) {
      confirmed = true;
      break;
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

  // Repo-scoped: this pairing belongs to THIS repo's bridge instance.
  setBridgeRelayToken(token, projectDir);
  const instanceLabel = body?.instance?.label || config.label;
  const instanceId = body?.instance?.id || "(unknown id)";
  console.log(`  ${C.green}Paired.${C.reset}`);
  console.log(`  ${C.dim}Instance:${C.reset} ${instanceLabel} (${instanceId})`);
  console.log(`  ${C.dim}Relay token stored for this repo.${C.reset}\n`);
  return { ok: true, paired: true, instance: body.instance };
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

  if (!wait) return { ok: true, bridge, info };

  const signal = await waitForShutdown();
  await bridge.stop();
  console.log(`\n  ${C.yellow}Posse bridge stopped${signal ? ` (${signal})` : ""}.${C.reset}\n`);
  return { ok: true, signal };
}
