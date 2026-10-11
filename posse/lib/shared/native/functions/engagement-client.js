// Strict synchronous client for low-frequency engagement policy decisions.
// Per-tool gates must use the persistent async worker; this path is reserved
// for orchestration boundaries such as blocked-turn recovery.

import fs from "node:fs";
import {
  ENGAGEMENT_CAPABILITIES_METHOD,
  ENGAGEMENT_CONTRACT_VERSION,
  ENGAGEMENT_RECOVERY_HINT_METHOD,
  ENGAGEMENT_RECOVERY_POLICY_DIGEST,
  PROVIDER_DISPATCH_CAPABILITIES_NEGATIVE_TTL_MS,
  PROVIDER_DISPATCH_CAPABILITIES_TTL_MS,
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
import { assertTestContext } from "../../../domains/runtime/functions/test-context.js";
import { nativeBinaries } from "../../tools/classes/BinaryManager.js";

const ENGAGEMENT_SYNC_TIMEOUT_MS = 10_000;
const PROVIDER_DISPATCH_NEGATIVE_CACHE_MS = 60_000;
const providerDispatchPromptFieldCache = new Map();
const providerDispatchPromptFieldOverridesForTests = new Map();
// One engagement.capabilities answer per posse-remote handle, checked against
// the binary file identity before reuse. BinaryManager replaces the handle when
// it installs another issued version.
let providerDispatchCapabilityProbes = new WeakMap();

export function __testResetProviderDispatchCapabilities() {
  assertTestContext("__testResetProviderDispatchCapabilities");
  providerDispatchCapabilityProbes = new WeakMap();
}

export function __testSetProviderDispatchPromptFields(provider, fields = null) {
  assertTestContext("__testSetProviderDispatchPromptFields");
  const key = String(provider || "").trim();
  if (!key) throw new TypeError("provider is required");
  if (fields == null) providerDispatchPromptFieldOverridesForTests.delete(key);
  else providerDispatchPromptFieldOverridesForTests.set(key, [...fields]);
}

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

function remoteBinaryHandle(manager) {
  try {
    const handle = manager.binary("remote");
    return handle && typeof handle === "object" ? handle : null;
  } catch {
    return null;
  }
}

function probeProviderDispatchContract(opts) {
  let capabilities;
  try {
    capabilities = callEngagementMethodSync(ENGAGEMENT_CAPABILITIES_METHOD, null, opts);
  } catch (error) {
    return { failure: { reason: error?.reason || "call-failed", message: String(error?.message || error) } };
  }
  const dispatch = capabilities.providerDispatch;
  const toolGateway = dispatch?.toolGateway;
  if (!isPlainObject(dispatch)
    || dispatch.command !== PROVIDER_DISPATCH_COMMAND
    || dispatch.protocol !== PROVIDER_DISPATCH_PROTOCOL
    || dispatch.cancellation !== true
    || dispatch.driftAttestation !== true
    || dispatch.independentToolDeadline !== true
    || dispatch.breakerStoreVersion !== PROVIDER_BREAKER_STORE_VERSION
    || !Array.isArray(dispatch.events)
    || dispatch.events.length !== PROVIDER_DISPATCH_EVENTS.length
    || PROVIDER_DISPATCH_EVENTS.some((event) => !dispatch.events.includes(event))
    || !isPlainObject(toolGateway)
    || toolGateway.protocol !== PROVIDER_TOOL_GATEWAY_PROTOCOL
    || toolGateway.path !== PROVIDER_TOOL_GATEWAY_PATH
    || toolGateway.maxRequestBytes !== PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES
    || toolGateway.maxResponseBytes !== PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES) {
    return { failure: { reason: "unsupported", message: "posse-remote does not serve the provider dispatch contract" } };
  }
  return { dispatch };
}

function providerDispatchOutcome(probe, provider) {
  if (probe.failure) return probe;
  const { dispatch } = probe;
  const providers = Array.isArray(dispatch.providers) ? dispatch.providers : [];
  if (!providers.includes(provider)) {
    const unavailableReason = isPlainObject(dispatch.unavailableReasons)
      && Object.hasOwn(dispatch.unavailableReasons, provider)
      && typeof dispatch.unavailableReasons[provider] === "string"
      ? dispatch.unavailableReasons[provider].trim() : "";
    return { failure: {
      reason: "unsupported-provider",
      message: unavailableReason
        ? `The ${provider} provider is unavailable: ${unavailableReason}`
        : `posse-remote does not include the ${provider} provider adapter`,
    } };
  }
  if (!isPlainObject(dispatch.adapterVersions)
    || typeof dispatch.adapterVersions[provider] !== "string"
    || !dispatch.adapterVersions[provider]) {
    return { failure: { reason: "unsupported-provider", message: `posse-remote has no compatible ${provider} adapter version` } };
  }
  return probe;
}

/**
 * Verify the independent streaming provider-dispatch contract.
 *
 * The probe blocks the event loop for a posse-remote spawn, and readiness
 * checks, provider selection and every dispatch ask it, so one answer serves
 * every provider until its catalog TTL lapses or the binary identity changes.
 * Each throw is a fresh error; callers may annotate what they catch.
 */
export function verifyProviderDispatchCapabilitiesSync(provider, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  const handle = remoteBinaryHandle(manager);
  const identity = engagementBinaryIdentity(manager);
  let probe = handle ? providerDispatchCapabilityProbes.get(handle) : null;
  let outcome = probe?.identity === identity ? providerDispatchOutcome(probe, provider) : null;
  const ttlMs = outcome?.dispatch
    ? PROVIDER_DISPATCH_CAPABILITIES_TTL_MS
    : PROVIDER_DISPATCH_CAPABILITIES_NEGATIVE_TTL_MS;
  const ageMs = outcome ? Date.now() - probe.probedAt : -1;
  if (!outcome || ageMs < 0 || ageMs >= ttlMs) {
    probe = { ...probeProviderDispatchContract({ ...opts, manager }), identity, probedAt: Date.now() };
    if (handle) providerDispatchCapabilityProbes.set(handle, probe);
    outcome = providerDispatchOutcome(probe, provider);
  }
  if (outcome.failure) throw engagementError(outcome.failure.reason, outcome.failure.message);
  return outcome.dispatch;
}

/**
 * Whether the installed posse-remote accepts an optional prompt field, such as
 * a conversation transcript. A binary that predates the field rejects any start
 * frame carrying it, so callers keep their older request shape until then.
 */
export function providerDispatchPromptFieldSupportedSync(provider, field, opts = {}) {
  const providerName = String(provider || "").trim();
  if (providerDispatchPromptFieldOverridesForTests.has(providerName)) {
    return providerDispatchPromptFieldOverridesForTests.get(providerName).includes(field);
  }
  const manager = opts.manager || nativeBinaries;
  const cacheKey = `${engagementBinaryIdentity(manager)}:${providerName}`;
  let cached = providerDispatchPromptFieldCache.get(cacheKey);
  if (!cached || (!cached.fields && cached.expiresAt <= Date.now())) {
    let fields = null;
    try {
      const dispatch = verifyProviderDispatchCapabilitiesSync(providerName, { ...opts, manager });
      fields = Array.isArray(dispatch.promptFields) ? dispatch.promptFields.map(String) : [];
    } catch { /* an unverifiable binary keeps the older request shape */ }
    cached = { fields, expiresAt: Date.now() + PROVIDER_DISPATCH_NEGATIVE_CACHE_MS };
    providerDispatchPromptFieldCache.set(cacheKey, cached);
  }
  return Boolean(cached.fields?.includes(field));
}

export function requestEngagementRecoveryHintSync(request, opts = {}) {
  return callEngagementMethodSync(ENGAGEMENT_RECOVERY_HINT_METHOD, {
    contract: ENGAGEMENT_CONTRACT_VERSION,
    ...request,
  }, opts);
}
