// lib/provider/model-catalog-validate.js
//
// Stale-model detection and runtime fallback. A user-configured model
// (`{provider}_model_{tier}` / `{provider}_image_model`) that is missing from
// or deprecated in the merged catalog is WARNED about and — depending on
// model_catalog_enforcement — silently substituted with the provider tier
// default at execution time. The user's setting is never rewritten and jobs
// never hard-fail on a stale model id.
//
// Enforcement modes (model_catalog_enforcement):
//   warn_and_fallback (default) — warn; deprecated/missing models resolve to
//                                 the tier default at runtime.
//   warn_only                   — warn but keep sending the configured model.
//   off                         — no validation, no fallback.
//
// Codex carve-out: the local Codex CLI probe (codex-model-validator.js) is
// authoritative for what the CLI accepts, so "missing from catalog" is
// warn-only for codex; only an explicit deprecated flag falls back.

import {
  MODEL_SETTING_DEFS,
  getDefaultImageModel,
  getDefaultTierModel,
  getModelCatalogStatus,
} from "./model-catalog.js";
import { getRemoteProviderCatalog } from "./model-catalog-store.js";
import { getAccountSetting } from "../../settings/functions/account-settings.js";
import { MODEL_CATALOG_ENFORCEMENT_VALUES } from "../../../catalog/settings.js";

export { MODEL_CATALOG_ENFORCEMENT_VALUES };

let _lastWarnings = [];
const _warnedOnce = new Set();

function getEnforcementMode() {
  try {
    const raw = String(getAccountSetting("model_catalog_enforcement") || "").trim().toLowerCase();
    if (MODEL_CATALOG_ENFORCEMENT_VALUES.includes(raw)) return raw;
  } catch {
    // Settings DB unavailable (tests/early bootstrap) — use the default.
  }
  return "warn_and_fallback";
}

function readConfiguredModel(key) {
  try {
    return String(getAccountSetting(key) || "").trim();
  } catch {
    return "";
  }
}

function warnOnce(key, configured, status, message) {
  const dedupeKey = `${key}:${configured}:${status}`;
  if (_warnedOnce.has(dedupeKey)) return;
  _warnedOnce.add(dedupeKey);
  try {
    console.error(`[model-catalog] ${message}`);
  } catch {
    // best-effort
  }
}

// Validation only applies once a remote catalog is cached for the provider.
// Against builtin-only data, "missing" is meaningless — the builtin lists are
// exactly what goes stale, and flagging user-typed day-0 models against them
// would produce false fallbacks.
function hasRemoteCatalogFor(provider) {
  try {
    return getRemoteProviderCatalog(provider) != null;
  } catch {
    return false;
  }
}

function classifyConfiguredModel(def, configured) {
  if (!hasRemoteCatalogFor(def.provider)) return null;
  const kind = def.kind === "image" ? "image" : "text";
  const status = getModelCatalogStatus(def.provider, configured, { kind });
  if (status.known && !status.deprecated) return null;
  const fallback = kind === "image"
    ? getDefaultImageModel(def.provider)
    : getDefaultTierModel(def.provider, def.tier);
  return {
    key: def.key,
    provider: def.provider,
    tier: def.tier || null,
    kind,
    configured,
    status: status.deprecated ? "deprecated" : "missing",
    successor: status.successor || null,
    fallback: fallback || null,
  };
}

/**
 * Validate every configured model setting against the merged catalog.
 * Returns the warning list (also cached for getModelCatalogWarnings) without
 * mutating any settings.
 */
export function validateConfiguredModels() {
  if (getEnforcementMode() === "off") {
    _lastWarnings = [];
    return _lastWarnings;
  }
  const warnings = [];
  for (const def of MODEL_SETTING_DEFS) {
    const configured = readConfiguredModel(def.key);
    if (!configured) continue;
    const warning = classifyConfiguredModel(def, configured);
    if (warning) warnings.push(warning);
  }
  _lastWarnings = warnings;
  return warnings;
}

/** Last computed warning list (empty until validateConfiguredModels runs). */
export function getModelCatalogWarnings() {
  return _lastWarnings;
}

/** Human-readable warning line for boot panel / logs. */
export function describeModelCatalogWarning(warning) {
  const scope = warning.kind === "image"
    ? `${warning.provider} image model`
    : `${warning.provider} ${warning.tier} model`;
  const reason = warning.status === "deprecated" ? "is deprecated" : "is not in the model catalog";
  const action = warning.fallback && warning.fallback !== warning.configured
    ? ` → falling back to ${warning.fallback}`
    : "";
  const successor = warning.successor ? ` (suggested: ${warning.successor})` : "";
  return `${scope} "${warning.configured}" ${reason}${action}${successor}`;
}

function resolveEffective({ provider, kind, tier, candidate, fallback }) {
  const configured = String(candidate || "").trim();
  if (!configured) return { model: configured, fellBack: false, reason: null };
  if (!hasRemoteCatalogFor(provider)) return { model: configured, fellBack: false, reason: null };
  const mode = getEnforcementMode();
  if (mode === "off") return { model: configured, fellBack: false, reason: null };

  const status = getModelCatalogStatus(provider, configured, { kind });
  if (status.known && !status.deprecated) return { model: configured, fellBack: false, reason: null };
  const reason = status.deprecated ? "deprecated" : "missing";

  const warningKey = kind === "image" ? `${provider}_image_model` : `${provider}_model_${tier}`;
  warnOnce(warningKey, configured, reason, describeModelCatalogWarning({
    key: warningKey,
    provider,
    tier,
    kind,
    configured,
    status: reason,
    successor: status.successor || null,
    fallback,
  }));

  if (mode === "warn_only") return { model: configured, fellBack: false, reason };
  // Codex: missing-from-catalog is warn-only — the local CLI probe decides.
  if (provider === "codex" && reason === "missing") return { model: configured, fellBack: false, reason };
  // Guard: never fall back onto an unknown model or onto nothing.
  if (!fallback || fallback === configured) return { model: configured, fellBack: false, reason };
  const fallbackStatus = getModelCatalogStatus(provider, fallback, { kind });
  if (!fallbackStatus.known || fallbackStatus.deprecated) {
    return { model: configured, fellBack: false, reason };
  }
  return { model: fallback, fellBack: true, reason };
}

/**
 * Resolve the model actually sent to the provider for a tier, substituting
 * the tier default when the candidate is stale (per enforcement mode).
 */
export function resolveEffectiveTierModel(provider, tier, candidate) {
  const providerKey = String(provider || "").trim().toLowerCase();
  const tierKey = String(tier || "standard").trim().toLowerCase();
  return resolveEffective({
    provider: providerKey,
    kind: "text",
    tier: tierKey,
    candidate,
    fallback: getDefaultTierModel(providerKey, tierKey),
  });
}

/** Image-model counterpart of resolveEffectiveTierModel. */
export function resolveEffectiveImageModel(provider, candidate) {
  const providerKey = String(provider || "").trim().toLowerCase();
  return resolveEffective({
    provider: providerKey,
    kind: "image",
    tier: null,
    candidate,
    fallback: getDefaultImageModel(providerKey),
  });
}

export function __resetModelCatalogValidationForTests() {
  _lastWarnings = [];
  _warnedOnce.clear();
}
