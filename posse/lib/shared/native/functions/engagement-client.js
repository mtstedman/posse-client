// Strict synchronous client for low-frequency engagement policy decisions.
// Per-tool gates must use the persistent async worker; this path is reserved
// for orchestration boundaries such as blocked-turn recovery.

import fs from "node:fs";
import {
  ENGAGEMENT_CAPABILITIES_METHOD,
  ENGAGEMENT_CONTRACT_VERSION,
  ENGAGEMENT_RECOVERY_HINT_METHOD,
  ENGAGEMENT_RECOVERY_POLICY_DIGEST,
} from "../../../catalog/binary.js";
import { buildRemoteNativeRequest } from "../../../domains/remote/functions/native-client.js";
import { nativeBinaries } from "../../tools/classes/BinaryManager.js";

const ENGAGEMENT_SYNC_TIMEOUT_MS = 10_000;

export function engagementBinaryIdentity(manager = nativeBinaries) {
  try {
    const binary = manager.binary("remote");
    const binaryPath = binary.resolvePath() || "<missing>";
    let stamp = "";
    try {
      const stat = fs.statSync(binaryPath);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch { /* missing is represented in the path */ }
    return `${binaryPath}@${binary.exactVersion || ""}:${stamp}`;
  } catch {
    return "<unresolved>";
  }
}

function engagementError(reason, message) {
  const error = /** @type {Error & { reason: string }} */ (new Error(message));
  error.reason = reason;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} method
 * @param {unknown} payload
 * @param {{ manager?: import("../../tools/classes/BinaryManager.js").BinaryManager, timeoutMs?: number }} [opts]
 */
export function callEngagementMethodSync(method, payload, { manager = nativeBinaries, timeoutMs = ENGAGEMENT_SYNC_TIMEOUT_MS } = {}) {
  if (!manager.shouldUse("remote")) throw engagementError("unavailable", "posse-remote is unavailable");
  const envelope = buildRemoteNativeRequest(method, payload);
  const result = manager.binary("remote").runSync(method, [], {
    input: `${JSON.stringify(envelope)}\n`,
    json: true,
    timeoutMs,
    localPolicy: true,
  });
  if (!result.ok) {
    throw engagementError("call-failed", String(result.stderr || result.error?.message || `${method} failed`).trim());
  }
  const value = /** @type {any} */ (result.json);
  if (value?.ok !== true || !isPlainObject(value.data)) {
    throw engagementError("invalid-response", `${method} returned no data`);
  }
  if (value.data.contract !== ENGAGEMENT_CONTRACT_VERSION) {
    throw engagementError("contract-mismatch", `${method} returned another contract`);
  }
  return value.data;
}

/** Verify the recovery method and its independent parity digest. */
export function verifyEngagementRecoveryCapabilitiesSync(opts = {}) {
  const capabilities = callEngagementMethodSync(ENGAGEMENT_CAPABILITIES_METHOD, null, opts);
  const methods = Array.isArray(capabilities.methods) ? capabilities.methods : [];
  if (!methods.includes(ENGAGEMENT_RECOVERY_HINT_METHOD)) {
    throw engagementError("unsupported", "posse-remote does not serve recovery policy");
  }
  if (capabilities.recoveryPolicyDigest !== ENGAGEMENT_RECOVERY_POLICY_DIGEST) {
    throw engagementError("policy-digest-mismatch", "posse-remote recovery policy does not match this client");
  }
  return capabilities;
}

export function requestEngagementRecoveryHintSync(request, opts = {}) {
  return callEngagementMethodSync(ENGAGEMENT_RECOVERY_HINT_METHOD, {
    contract: ENGAGEMENT_CONTRACT_VERSION,
    ...request,
  }, opts);
}
