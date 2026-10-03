// lib/domains/providers/functions/shared/engagement-launch.js
//
// Provider launch policy computed by posse-remote's engagement.launchPlan.
// The engagement_engine setting picks who decides: "js" keeps this client's
// own policy, "shadow" asks posse-remote too and logs any difference while
// still using the JS answer, and "native" uses posse-remote's answer. Native
// failures fall back to the JS answer while both implementations exist.
//
// Engagement methods are pure local policy, so they run without a heartbeat
// pulse (NativeBinary `localPolicy`). posse-remote is probed once per process
// (contract and policy digest) before it is asked for plans; a missing, old,
// or mismatched binary keeps the JS policy and is reported once per reason.
// Differences are logged as hashes and key names only, never as values.

import crypto from "node:crypto";
import {
  ENGAGEMENT_CAPABILITIES_METHOD,
  ENGAGEMENT_CONTRACT_VERSION,
  ENGAGEMENT_LAUNCH_PLAN_METHOD,
  ENGAGEMENT_POLICY_DIGEST,
} from "../../../../catalog/binary.js";
import { ENGAGEMENT_ENGINE_VALUES, SETTING_KEYS } from "../../../../catalog/settings.js";
import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { getSetting } from "../../../queue/functions/index.js";
import { buildRemoteNativeRequest } from "../../../remote/functions/native-client.js";
import { engagementCapabilityCache } from "../../classes/EngagementCapabilityCache.js";

const ENGAGEMENT_TIMEOUT_MS = 10_000;

/** @typedef {import("../../../../shared/tools/classes/BinaryManager.js").BinaryManager} BinaryManager */

/**
 * An engagement failure with a short reason code (never policy content).
 *
 * @param {string} reason
 * @param {string} message
 */
function engagementError(reason, message) {
  const error = /** @type {Error & { reason: string }} */ (new Error(message));
  error.reason = reason;
  return error;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @returns {"js" | "shadow" | "native"} */
export function resolveEngagementEngine() {
  try {
    const stored = String(getSetting(SETTING_KEYS.ENGAGEMENT_ENGINE) ?? "").trim().toLowerCase();
    if (ENGAGEMENT_ENGINE_VALUES.includes(stored)) return /** @type {"js" | "shadow" | "native"} */ (stored);
  } catch {
    // Settings unavailable (tests, early boot): keep the JS policy.
  }
  return "js";
}

/**
 * @param {{ ok: boolean, stderr?: string, error?: (Error & { code?: string }) | null }} res
 * @param {string} method
 */
function failureFromRun(res, method) {
  const detail = String(res.stderr || res.error?.message || `${method} failed`).trim();
  if (/not available|ENOENT/i.test(detail)) return engagementError("unavailable", detail);
  if (/timed out/i.test(detail)) return engagementError("timeout", detail);
  if (/unsupported (remote command|engagement method)/i.test(detail)) return engagementError("unsupported", detail);
  if (/contract mismatch/i.test(detail)) return engagementError("contract-mismatch", detail);
  if (res.error?.code === "POSSE_NATIVE_LOCAL_POLICY_REFUSED") return engagementError("refused", detail);
  return engagementError("call-failed", detail);
}

/**
 * Call one engagement method on posse-remote without a pulse and return the
 * envelope's `data`.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {{ manager?: BinaryManager, timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function callEngagementMethod(method, payload, { manager = nativeBinaries, timeoutMs = ENGAGEMENT_TIMEOUT_MS, maxBuffer } = {}) {
  if (!manager.shouldUse("remote")) throw engagementError("unavailable", "posse-remote is unavailable");
  const envelope = buildRemoteNativeRequest(method, payload);
  const res = await manager.binary("remote").run(method, [], {
    input: `${JSON.stringify(envelope)}\n`,
    json: true,
    timeoutMs,
    localPolicy: true,
    ...(maxBuffer ? { maxBuffer } : {}),
  });
  if (!res.ok) throw failureFromRun(res, method);
  const value = /** @type {any} */ (res.json);
  if (value?.ok !== true || !isPlainObject(value.data)) {
    throw engagementError("invalid-response", `${method} returned no data`);
  }
  if (value.data.contract !== ENGAGEMENT_CONTRACT_VERSION) {
    throw engagementError("contract-mismatch", `${method} contract ${value.data.contract} is not ${ENGAGEMENT_CONTRACT_VERSION}`);
  }
  return value.data;
}

/**
 * Ask posse-remote for a launch plan. `request` is the full payload
 * (`{ contract, claude?, codex? }`). Throws when the binary is missing, the
 * call fails, or the answer is for a different contract version.
 *
 * @param {Record<string, unknown>} request
 * @param {{ manager?: BinaryManager, timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export function requestEngagementLaunchPlan(request, opts = {}) {
  return callEngagementMethod(ENGAGEMENT_LAUNCH_PLAN_METHOD, request, opts);
}

/**
 * Check `engagement.capabilities`: same contract, launch plans served, and a
 * policy digest equal to this client's golden fixture digest.
 *
 * @param {{ manager?: BinaryManager, timeoutMs?: number }} [opts]
 */
export async function verifyEngagementCapabilities(opts = {}) {
  const capabilities = await callEngagementMethod(ENGAGEMENT_CAPABILITIES_METHOD, null, opts);
  const methods = Array.isArray(capabilities.methods) ? capabilities.methods : [];
  if (!methods.includes(ENGAGEMENT_LAUNCH_PLAN_METHOD)) {
    throw engagementError("unsupported", `posse-remote does not serve ${ENGAGEMENT_LAUNCH_PLAN_METHOD}`);
  }
  if (capabilities.policyDigest !== ENGAGEMENT_POLICY_DIGEST) {
    throw engagementError("policy-digest-mismatch", "posse-remote was verified against a different engagement policy fixture");
  }
  return capabilities;
}

/** @param {BinaryManager} manager */
function remoteBinaryKey(manager) {
  try {
    const handle = manager.binary("remote");
    return `${handle.resolvePath() || "<missing>"}@${handle.exactVersion || ""}`;
  } catch {
    return "<unresolved>";
  }
}

/**
 * Whether posse-remote may be asked for launch plans in this process: probed
 * once, cached, retried with backoff after a failure.
 *
 * @param {{ manager?: BinaryManager }} [opts]
 */
export function probeEngagementCapabilities({ manager = nativeBinaries } = {}) {
  return engagementCapabilityCache.check(manager, remoteBinaryKey(manager), () => verifyEngagementCapabilities({ manager }));
}

/**
 * @param {string} reason
 * @param {Record<string, unknown>} fields
 */
function warnOncePerReason(reason, fields) {
  if (!engagementCapabilityCache.firstTime(`unavailable:${reason}`)) return;
  log.warn("engagement", "posse-remote launch plan unavailable; using the JS policy", { reason, ...fields });
}

/** Test hook: forget probe results and logged warnings. */
export function __resetEngagementLaunchStateForTests() {
  engagementCapabilityCache.reset();
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * Dotted paths of the leaves where `a` and `b` differ (names only, never
 * values). Arrays compare as a whole.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function differingKeyPaths(a, b, prefix = "") {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => differingKeyPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || "<root>"];
}

/**
 * Pick the launch policy for one provider section.
 *
 * @template T
 * @param {{
 *   provider: "claude" | "codex",
 *   role?: string | null,
 *   request: () => Record<string, unknown>,
 *   jsValue: T,
 *   nativeValue: (plan: Record<string, any>) => T,
 *   engine?: "js" | "shadow" | "native",
 *   manager?: BinaryManager,
 * }} args
 * @returns {Promise<T>}
 */
export async function reconcileLaunchPolicy({ provider, role = null, request, jsValue, nativeValue, engine = resolveEngagementEngine(), manager = nativeBinaries }) {
  if (engine === "js") return jsValue;
  const capability = await probeEngagementCapabilities({ manager });
  if (!capability.ok) {
    warnOncePerReason(capability.reason, { provider, role, engine, error: capability.message });
    return jsValue;
  }
  let nativeResult;
  try {
    const plan = await requestEngagementLaunchPlan({ contract: ENGAGEMENT_CONTRACT_VERSION, [provider]: request() }, { manager });
    nativeResult = nativeValue(plan);
  } catch (error) {
    engagementCapabilityCache.markFailed(manager, remoteBinaryKey(manager), error);
    const reason = /** @type {any} */ (error)?.reason || "call-failed";
    warnOncePerReason(reason, {
      provider,
      role,
      engine,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsValue;
  }
  const jsDigest = digest(jsValue);
  const nativeDigest = digest(nativeResult);
  if (jsDigest !== nativeDigest && engagementCapabilityCache.firstTime(`mismatch:${provider}:${role}:${jsDigest}:${nativeDigest}`)) {
    log.warn("engagement", "posse-remote launch plan differs from the JS policy", {
      provider,
      role,
      engine,
      jsDigest,
      nativeDigest,
      fields: differingKeyPaths(jsValue, nativeResult),
    });
  }
  return engine === "native" ? nativeResult : jsValue;
}

/**
 * The `codex` section of a launch-plan request: the facts
 * buildCodexSystemToolLockdownOverrides and buildCodexResearchBootOverrides
 * decide on. Every flag is sent as an explicit boolean (the binary requires
 * each one), with the same truthiness the JS builders apply.
 *
 * @param {{ role?: unknown, disableSystemTools?: unknown, disableNativeImageGeneration?: unknown, disableResearcherUtilities?: unknown, codexCodeMode?: unknown, codexNativeBatching?: unknown, webToolsActive?: unknown }} input
 * @param {string} researchBaseInstructionsPath
 */
export function buildCodexLaunchInput(input, researchBaseInstructionsPath) {
  return {
    role: typeof input.role === "string" ? input.role : null,
    disableSystemTools: !!input.disableSystemTools,
    disableNativeImageGeneration: !!input.disableNativeImageGeneration,
    disableResearcherUtilities: !!input.disableResearcherUtilities,
    codexCodeMode: !!input.codexCodeMode,
    codexNativeBatching: !!input.codexNativeBatching,
    webToolsActive: !!input.webToolsActive,
    researchBaseInstructionsPath,
  };
}

// ── Native answer validation ─────────────────────────────────────────────────
// A partial or malformed answer must never widen the launch surface: every
// field is required with its exact type, unknown fields are rejected, and any
// mismatch throws so the JS policy is used instead.

/**
 * @param {unknown} value
 * @param {Record<string, "object" | "string" | "string|null" | "boolean" | "string[]">} shape
 * @param {string} where
 * @returns {Record<string, any>}
 */
function requireShape(value, shape, where) {
  if (!isPlainObject(value)) throw engagementError("invalid-plan", `${where} is missing`);
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) throw engagementError("invalid-plan", `${where}.${key} is unexpected`);
  }
  for (const [key, type] of Object.entries(shape)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw engagementError("invalid-plan", `${where}.${key} is missing`);
    const field = value[key];
    const ok = type === "object" ? isPlainObject(field)
      : type === "string" ? typeof field === "string"
        : type === "string|null" ? (field === null || typeof field === "string")
          : type === "boolean" ? typeof field === "boolean"
            : Array.isArray(field) && field.every((item) => typeof item === "string");
    if (!ok) throw engagementError("invalid-plan", `${where}.${key} is not ${type}`);
  }
  return value;
}

/**
 * @param {Record<string, any>} plan
 * @param {"claude" | "codex"} provider
 */
function requireSection(plan, provider) {
  if (!isPlainObject(plan)) throw engagementError("invalid-plan", "plan is missing");
  for (const key of Object.keys(plan)) {
    if (key !== "contract" && key !== "claude" && key !== "codex") throw engagementError("invalid-plan", `plan.${key} is unexpected`);
  }
  if (plan.contract !== ENGAGEMENT_CONTRACT_VERSION) throw engagementError("contract-mismatch", `plan contract ${plan.contract} is not ${ENGAGEMENT_CONTRACT_VERSION}`);
  return plan[provider];
}

/**
 * The Claude section of a native plan, validated, in call-site form.
 *
 * @param {Record<string, any>} plan
 */
export function claudeLaunchPolicyFromPlan(plan) {
  const section = requireShape(requireSection(plan, "claude"), { cliToolConfig: "object", permissionArgs: "object" }, "claude");
  return {
    cliToolConfig: normalizeClaudeCliToolConfig(requireShape(section.cliToolConfig, {
      tools: "string|null",
      disallowedTools: "string|null",
      allowedTools: "string|null",
      dangerouslySkipPermissions: "boolean",
    }, "claude.cliToolConfig")),
    permissionArgs: normalizeClaudePermissionArgs(requireShape(section.permissionArgs, {
      toolsArg: "string|null",
      disallowedToolsArg: "string|null",
      allowedToolsArg: "string",
    }, "claude.permissionArgs")),
  };
}

/**
 * The Codex section of a native plan, validated, in call-site form.
 *
 * @param {Record<string, any>} plan
 */
export function codexLaunchOverridesFromPlan(plan) {
  return normalizeCodexLaunchOverrides(requireShape(requireSection(plan, "codex"), {
    lockdownOverrides: "string[]",
    researchBootOverrides: "string[]",
  }, "codex"));
}

/**
 * Claude permission flags as the call site uses them.
 *
 * @param {{ toolsArg?: string | null, disallowedToolsArg?: string | null, allowedToolsArg?: string }} args
 */
export function normalizeClaudePermissionArgs(args = {}) {
  return {
    toolsArg: args.toolsArg ?? null,
    disallowedToolsArg: args.disallowedToolsArg ?? null,
    allowedToolsArg: String(args.allowedToolsArg ?? ""),
  };
}

/**
 * The built-in surface toClaudeCliFlags returns, with absent fields made
 * explicit (null / false) so it compares field by field.
 *
 * @param {Record<string, any>} config
 */
export function normalizeClaudeCliToolConfig(config = {}) {
  return {
    tools: config.tools ?? null,
    disallowedTools: config.disallowedTools ?? null,
    allowedTools: config.allowedTools ?? null,
    dangerouslySkipPermissions: !!config.dangerouslySkipPermissions,
  };
}

/**
 * Codex config overrides as the call site uses them.
 *
 * @param {{ lockdownOverrides?: string[], researchBootOverrides?: string[] }} plan
 */
export function normalizeCodexLaunchOverrides(plan = {}) {
  return {
    lockdownOverrides: [...(plan.lockdownOverrides || [])],
    researchBootOverrides: [...(plan.researchBootOverrides || [])],
  };
}
