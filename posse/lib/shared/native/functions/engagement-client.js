// Strict synchronous client for low-frequency engagement policy decisions.
// Per-tool gates must use the persistent async worker; this path is reserved
// for orchestration boundaries such as blocked-turn recovery.

import fs from "node:fs";
import {
  ENGAGEMENT_CAPABILITIES_METHOD,
  ENGAGEMENT_CONTRACT_VERSION,
  ENGAGEMENT_RECOVERY_HINT_METHOD,
  ENGAGEMENT_RECOVERY_POLICY_DIGEST,
  PROVIDER_DISPATCH_COMMAND,
  PROVIDER_BREAKER_STORE_VERSION,
  PROVIDER_DISPATCH_EVENTS,
  PROVIDER_DISPATCH_PROTOCOL,
  PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES,
  PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES,
  PROVIDER_TOOL_GATEWAY_PATH,
  PROVIDER_TOOL_GATEWAY_PROTOCOL,
} from "../../../catalog/binary.js";
import { buildRemoteNativeRequest } from "../../../domains/remote/functions/native-client.js";
import { nativeBinaries } from "../../tools/classes/BinaryManager.js";

const ENGAGEMENT_SYNC_TIMEOUT_MS = 10_000;
const PROVIDER_DISPATCH_NEGATIVE_CACHE_MS = 60_000;
const providerDispatchSupportCache = new Map();

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

/** Verify the independent streaming provider-dispatch contract. */
export function verifyProviderDispatchCapabilitiesSync(provider, opts = {}) {
  const capabilities = callEngagementMethodSync(ENGAGEMENT_CAPABILITIES_METHOD, null, opts);
  const dispatch = capabilities.providerDispatch;
  const toolGateway = dispatch?.toolGateway;
  if (!isPlainObject(dispatch)
    || dispatch.command !== PROVIDER_DISPATCH_COMMAND
    || dispatch.protocol !== PROVIDER_DISPATCH_PROTOCOL
    || dispatch.cancellation !== true
    || dispatch.driftAttestation !== true
    || dispatch.breakerStoreVersion !== PROVIDER_BREAKER_STORE_VERSION
    || !Array.isArray(dispatch.events)
    || dispatch.events.length !== PROVIDER_DISPATCH_EVENTS.length
    || PROVIDER_DISPATCH_EVENTS.some((event) => !dispatch.events.includes(event))
    || !isPlainObject(toolGateway)
    || toolGateway.protocol !== PROVIDER_TOOL_GATEWAY_PROTOCOL
    || toolGateway.path !== PROVIDER_TOOL_GATEWAY_PATH
    || toolGateway.maxRequestBytes !== PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES
    || toolGateway.maxResponseBytes !== PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES) {
    throw engagementError("unsupported", "posse-remote does not serve the provider dispatch contract");
  }
  const providers = Array.isArray(dispatch.providers) ? dispatch.providers : [];
  if (!providers.includes(provider)) {
    throw engagementError("unsupported-provider", `posse-remote does not include the ${provider} provider adapter`);
  }
  if (!isPlainObject(dispatch.adapterVersions)
    || typeof dispatch.adapterVersions[provider] !== "string"
    || !dispatch.adapterVersions[provider]) {
    throw engagementError("unsupported-provider", `posse-remote has no compatible ${provider} adapter version`);
  }
  return dispatch;
}

/**
 * Rollout probe for a provider adapter. An adapter that is not advertised
 * leaves the existing executor in place; once advertised, the caller must use
 * the native route and let later compatibility/runtime failures fail closed.
 */
export function providerDispatchSupportedSync(provider, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  const cacheKey = `${engagementBinaryIdentity(manager)}:${String(provider || "")}`;
  const cached = providerDispatchSupportCache.get(cacheKey);
  if (cached && (cached.supported || cached.expiresAt > Date.now())) {
    return cached.supported;
  }
  let supported = false;
  try {
    verifyProviderDispatchCapabilitiesSync(provider, { ...opts, manager });
    supported = true;
  } catch {
    supported = false;
  }
  providerDispatchSupportCache.set(cacheKey, {
    supported,
    expiresAt: supported ? Number.POSITIVE_INFINITY : Date.now() + PROVIDER_DISPATCH_NEGATIVE_CACHE_MS,
  });
  return supported;
}

export function requestEngagementRecoveryHintSync(request, opts = {}) {
  return callEngagementMethodSync(ENGAGEMENT_RECOVERY_HINT_METHOD, {
    contract: ENGAGEMENT_CONTRACT_VERSION,
    ...request,
  }, opts);
}
