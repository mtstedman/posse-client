// lib/provider/provider.js — Provider router
//
// Selects the right LLM provider (claude, openai, codex, grok, copilot) per role based on
// global account settings. Re-exports the unified interface so callers
// don't need to know which backend is active.
//
// Multi-provider: settings support comma-separated lists (e.g. "claude,openai").
// Execution treats the configured list as an equal-weight pool.

import { getArtifactProtocol, getConfiguredImageProviders } from "../../artifacts/functions/index.js";
import { getAtlasIntegrationConfig, getAtlasProviderSupport } from "../../integrations/functions/atlas.js";
import { getSetting, setSetting } from "../../queue/functions/index.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { classifyProviderError } from "./shared/api-resilience.js";
import { providerRegistry, optionalProvidersMissingModule, reloadOptionalProvider } from "../classes/registry-singleton.js";
import { providerRuntimeState } from "../classes/runtime-state-singleton.js";
import { getDefaultTierModel, PROVIDER_OPTIONS } from "./model-catalog.js";
import { isProviderEnabledByCatalog } from "./model-catalog-store.js";
import { resolveEffectiveTierModel } from "./model-catalog-validate.js";
import {
  DELEGATION_PROVIDER_ROLE_NAMES,
  PROVIDER_ROLE_NAMES,
  providerRoleForJobType,
} from "./roles.js";

const PERSISTED_RATE_LIMIT_MIN_SECONDS = 60;

// ─── Provider Modules ─────────────────────────────────────────────────────
//
// `providerRegistry` is constructed in the class tree
// (lib/domains/providers/classes/registry-singleton.js) and re-exported here so
// existing call sites don't have to track the move.

export { providerRegistry };

function canonicalProviderName(providerName) {
  return providerRegistry.canonicalName(providerName);
}

/**
 * Returns a fresh Set of canonical provider names whose modules declare
 * `capabilities.images = true`. Computed live so providers loaded after
 * this module's eager import (codex/openai/grok dynamic imports below)
 * are included.
 */
export function getImageCapableProviders() {
  const result = new Set();
  for (const name of providerRegistry.providers.keys()) {
    const provider = providerRegistry.get(name);
    if (provider?.hasCapability?.("images")) result.add(name);
  }
  return result;
}

export function isImageCapableProvider(providerName) {
  const canonicalName = canonicalProviderName(providerName);
  const provider = providerRegistry.get(canonicalName);
  return Boolean(provider?.hasCapability?.("images"));
}

export function getSessionResumeCapableProviders() {
  const result = new Set();
  for (const name of providerRegistry.providers.keys()) {
    const provider = providerRegistry.get(name);
    if (provider?.hasCapability?.("sessionResume")) result.add(name);
  }
  return result;
}

export function isSessionResumeCapableProvider(providerName) {
  const canonicalName = canonicalProviderName(providerName);
  const provider = providerRegistry.get(canonicalName);
  return Boolean(provider?.hasCapability?.("sessionResume"));
}

export function getProviderAtlasSupport(providerName, {
  config = getAtlasIntegrationConfig(),
} = {}) {
  const canonicalName = canonicalProviderName(providerName || "claude");
  return getAtlasProviderSupport(canonicalName, { config });
}

export function providerSupportsAtlas(providerName, opts = {}) {
  return getProviderAtlasSupport(providerName, opts).supported;
}

export function getProviderAtlasMap({ config = getAtlasIntegrationConfig() } = {}) {
  const providers = PROVIDER_OPTIONS;
  return Object.fromEntries(providers.map((providerName) => [
    providerName,
    getProviderAtlasSupport(providerName, { config }),
  ]));
}

/** Resolve a provider module by name. */
function resolveProviderModule(providerName = "claude") {
  const canonicalName = canonicalProviderName(providerName || "claude");
  const provider = providerRegistry.get(canonicalName);
  if (provider) return provider;
  const loadErr = providerRegistry.getLoadError(canonicalName);
  const reason = loadErr
    ? loadErr.message?.split("\n")[0] || String(loadErr)
    : `provider module "${canonicalName}" not loaded`;
  const err = new Error(`Provider "${providerName}" is unavailable: ${reason}`);
  err.code = "PROVIDER_MODULE_UNAVAILABLE";
  err.provider = canonicalName;
  throw err;
}

// ─── Provider Resolution ────────────────────────────────────────────────────

// Parse provider config — first value in comma-separated list is the default
function parseProviderList(value) {
  if (!value) return ["claude"];
  const providers = value
    .split(",")
    .map((s) => canonicalProviderName(s))
    .filter(Boolean);
  return providers.length > 0 ? providers : ["claude"];
}

function readDbSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function persistedRateLimitSettingKey(providerName) {
  return `${canonicalProviderName(providerName)}_rate_limit_state`;
}

function readPersistedRateLimitState(providerName, { nowMs = Date.now() } = {}) {
  const canonicalName = canonicalProviderName(providerName);
  let parsed = null;
  try {
    const raw = getSetting(persistedRateLimitSettingKey(canonicalName));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const untilMs = Number(parsed?.untilMs);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    try { setSetting(persistedRateLimitSettingKey(canonicalName), null); } catch {}
    return null;
  }

  return {
    blocked: true,
    retryInSec: Math.ceil((untilMs - nowMs) / 1000),
    reason: String(parsed?.reason || "persisted_rate_limit"),
    persisted: true,
  };
}

function persistRateLimitState(providerName, backoffSec, reason = "") {
  const canonicalName = canonicalProviderName(providerName);
  const sec = Math.max(0, Number(backoffSec) || 0);
  const key = persistedRateLimitSettingKey(canonicalName);
  if (sec <= 0) {
    try { setSetting(key, null); } catch {}
    return;
  }
  if (sec < PERSISTED_RATE_LIMIT_MIN_SECONDS) return;

  const nowMs = Date.now();
  const untilMs = nowMs + sec * 1000;
  const current = readPersistedRateLimitState(canonicalName, { nowMs });
  if (current?.blocked && nowMs + current.retryInSec * 1000 >= untilMs) return;

  try {
    setSetting(key, JSON.stringify({
      untilMs,
      reason: String(reason || "rate_limit"),
      updatedAt: new Date(nowMs).toISOString(),
    }));
  } catch {
    // Account settings can be unavailable in isolated provider tests.
  }
}

function getRoleProviderList(role = "dev") {
  const configured = readDbSetting(`provider_${role}`) || null;
  return parseProviderList(configured);
}

function getExplicitConfiguredProviderSet() {
  const configured = new Set();
  for (const role of PROVIDER_ROLE_NAMES) {
    const value = readDbSetting(`provider_${role}`) || null;
    if (!value) continue;
    for (const provider of parseProviderList(value)) configured.add(provider);
  }

  return configured;
}

function getEffectiveUsageProviderSet() {
  const providers = new Set(getExplicitConfiguredProviderSet());
  for (const role of PROVIDER_ROLE_NAMES) {
    providers.add(getProviderName(role));
  }
  for (const provider of getConfiguredImageProviders()) {
    providers.add(provider);
  }
  return providers;
}

/**
 * Get the provider module for a given role (or explicit provider name).
 * If providerName is given, use it directly. Otherwise resolve from saved settings.
 * Returns the provider module object, which exports callProvider,
 * extractJson, escalateTier, MODEL_TIERS, and provider lifecycle helpers.
 */
export function getProvider(role = "dev", providerName = null) {
  const name = providerName || selectProviderName(role);
  const canonicalName = canonicalProviderName(name || "claude");

  if (canonicalName !== "claude" && !providerRegistry.has(canonicalName)) {
    throw new Error(
      `Provider "${name}" selected for role "${role}" but not loaded. ` +
      (canonicalName === "openai"
        ? "Ensure the 'openai' package is installed: npm install openai"
        : canonicalName === "codex"
          ? "Ensure the Codex CLI is installed and accessible."
          : canonicalName === "grok"
            ? "Ensure the 'openai' package is installed and XAI_API_KEY is configured."
          : `No module found for provider "${name}".`)
    );
  }

  const provider = providerRegistry.get(canonicalName);
  if (provider) return provider;

  const loadErr = providerRegistry.getLoadError(canonicalName);
  const reason = loadErr
    ? loadErr.message?.split("\n")[0] || String(loadErr)
    : `provider "${canonicalName}" is not loaded`;
  throw new Error(`Provider "${name}" selected for role "${role}" but not loaded: ${reason}`);
}

/**
 * Get the default provider name string for a given role.
 * Returns the first provider in the comma-separated list.
 */
export function getProviderName(role = "dev") {
  return getRoleProviderList(role)[0] || "claude";
}

export function selectProviderName(role = "dev") {
  const configured = getRoleProviderList(role);
  if (configured.length <= 1) return configured[0] || "claude";
  const ready = configured.filter((providerName) => isProviderReady(providerName).ready);
  const readinessPool = ready.length > 0 ? ready : configured;
  const available = readinessPool.filter((providerName) => {
    try {
      return !getProviderRateLimitState(providerName).blocked;
    } catch {
      return true;
    }
  });
  const pool = available.length > 0 ? available : readinessPool;
  const cursorKey = `role:${role}`;
  const cursor = providerRegistry.cursorNext(cursorKey);
  const selected = pool[cursor % pool.length] || pool[0] || "claude";
  return selected;
}

export function nextProviderSelectionCursor(key) {
  return providerRegistry.cursorNext(key);
}

/**
 * Get all available providers for a given role.
 * Returns the full comma-separated list (or global override as a single-element list).
 * Used by the delegator to know which providers it can assign.
 */
export function getAvailableProviders(role = "dev") {
  return getRoleProviderList(role);
}

/**
 * Check whether a role has multiple providers configured.
 * When true, the delegator step should run to assign providers per-job.
 */
export function isMultiProvider(role = "dev") {
  return getAvailableProviders(role).length > 1;
}

/**
 * Check whether ANY role has multiple providers, meaning delegation is useful.
 */
export function needsDelegation() {
  return DELEGATION_PROVIDER_ROLE_NAMES.some((role) => getAvailableProviders(role).length > 1);
}

/**
 * Build a summary of available providers per role for the delegator prompt.
 * Returns an object like { dev: ["claude","openai"], assessor: ["claude"] }.
 */
export function getProviderMap() {
  const map = {};
  for (const role of DELEGATION_PROVIDER_ROLE_NAMES) {
    map[role] = getAvailableProviders(role);
  }
  return map;
}

/**
 * Get model tier info for a specific provider+tier combination.
 * Returns { model, label, ... } from that provider's MODEL_TIERS.
 */
export function getProviderTierInfo(providerName, tier) {
  const mod = resolveProviderModule(providerName);
  if (typeof mod.getModelTierConfig === "function") {
    return mod.getModelTierConfig(tier);
  }
  return mod.MODEL_TIERS[tier] || mod.MODEL_TIERS.standard;
}

// ─── Tier → Model Name ──────────────────────────────────────────────────────

/**
 * Resolve a model tier to its concrete model identifier.
 * Provider-aware: pass providerName ("claude", "openai"), role ("dev", "assessor"),
 * or jobType ("research", "fix") to auto-resolve the provider via saved settings.
 * Falls back to the default provider (claude) when none is given.
 */
export function tierModelName(tier, { providerName, role, jobType } = {}) {
  let name = providerName;
  if (!name) {
    const resolvedRole = role || providerRoleForJobType(jobType) || "dev";
    name = getProviderName(resolvedRole);
  }
  const providerKey = canonicalProviderName(name);
  const tierConfig = getProviderTierInfo(providerKey, tier);
  const candidate = tierConfig.model || getDefaultTierModel(providerKey, tier);
  // Stale-model guard: a configured model that vanished from the merged
  // catalog warns and resolves to the tier default (per enforcement mode)
  // instead of failing at the provider API.
  return resolveEffectiveTierModel(providerKey, tier, candidate).model;
}

// ─── Provider Readiness ─────────────────────────────────────────────────────

// Node raises ERR_MODULE_NOT_FOUND when a provider's import graph can't be
// resolved. The message names the unresolved specifier — e.g. "Cannot find
// package 'agentkeepalive' imported from ...". That specifier is the real
// culprit, which may be the optional `openai` SDK itself or one of its
// transitive deps (as happens with a partially-installed node_modules).
function missingModuleSpecifier(loadErr) {
  const match = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(loadErr?.message || "");
  return match ? match[1] : null;
}

// Translate a provider module's load error into an actionable reason. For
// ERR_MODULE_NOT_FOUND we name the actual missing dependency rather than
// blaming `openai` unconditionally — otherwise a missing transitive dep sends
// the user to run `npm install openai`, which is already installed and won't help.
function providerLoadErrorReason(canonicalName, loadErr) {
  if (!loadErr) return `provider module "${canonicalName}" not loaded`;
  if (loadErr.code !== "ERR_MODULE_NOT_FOUND") {
    return loadErr.message?.split("\n")[0] || String(loadErr);
  }
  const missing = missingModuleSpecifier(loadErr);
  if (missing && missing !== "openai") {
    return `${canonicalName} provider dependency "${missing}" not installed (run npm install)`;
  }
  // The openai SDK itself is missing (or the specifier was unparseable).
  return canonicalName === "codex"
    ? "codex provider dependencies not available"
    : "openai package not installed (npm install openai)";
}

// ─── Provider Dependency Self-Heal ──────────────────────────────────────────

/**
 * Optional providers that failed to LOAD at boot because of a missing module
 * (ERR_MODULE_NOT_FOUND) — the one provider-load failure that a dependency
 * install can recover. The common case is the openai SDK's transitive
 * `agentkeepalive` shim being dropped from node_modules by an npm prune/partial
 * install, which hard-fails grok/openai/codex at boot on EVERY boot because the
 * boot dependency check is dryRun and never installs.
 *
 * @returns {string[]} canonical provider names
 */
export function getProvidersNeedingDependencyRepair() {
  return optionalProvidersMissingModule();
}

/**
 * Self-heal optional providers whose missing module is install-recoverable: run
 * a (caller-supplied) scoped node dependency install, then re-import each
 * affected provider in-process so its chip flips ✗ → ✓ with no restart. The
 * install runner is injected so this stays decoupled from the dependency-sync
 * worker (and is trivially mockable in tests). Always best-effort: a failed
 * install or a still-broken re-import is reported, never thrown.
 *
 * @param {{
 *   runNodeDependencySync?: (opts: { signal?: AbortSignal|null, onProgress?: ((message: string) => void)|null, forceNodeInstall?: boolean }) => Promise<any>,
 *   onProgress?: ((message: string) => void) | null,
 *   signal?: AbortSignal | null,
 * }} [input]
 * @returns {Promise<{ attempted: boolean, missing: string[], repaired: string[], stillBroken: string[], install: any }>}
 */
export async function repairMissingProviderDependencies({
  runNodeDependencySync,
  onProgress = null,
  signal = null,
} = {}) {
  const firstErrLine = (value) => String(value?.message || value || "").split("\n")[0];
  const missing = getProvidersNeedingDependencyRepair();
  if (missing.length === 0) {
    return { attempted: false, missing: [], repaired: [], stillBroken: [], install: null };
  }
  if (typeof runNodeDependencySync !== "function") {
    return { attempted: false, missing, repaired: [], stillBroken: missing, install: null };
  }
  onProgress?.(`repairing provider dependencies: ${missing.join(", ")}`);
  let install = null;
  try {
    // The provider load error itself proves the tree is incomplete. Force a
    // manifest-backed install even when top-level package probes and the manifest
    // stamp otherwise look healthy.
    install = await runNodeDependencySync({ signal, onProgress, forceNodeInstall: true });
  } catch (err) {
    return { attempted: true, missing, repaired: [], stillBroken: missing, install: { ok: false, error: firstErrLine(err) } };
  }
  if (signal?.aborted) {
    return { attempted: true, missing, repaired: [], stillBroken: missing, install };
  }
  const repaired = [];
  const stillBroken = [];
  for (const name of missing) {
    // eslint-disable-next-line no-await-in-loop -- re-imports are cheap and serialized to keep registry writes ordered
    const ok = await reloadOptionalProvider(name);
    (ok ? repaired : stillBroken).push(name);
  }
  return { attempted: true, missing, repaired, stillBroken, install };
}

/**
 * Check whether a provider is operationally ready (module loaded + credentials present).
 * Use this during plan validation to reject jobs early rather than failing at execution time.
 *
 * @param {string} providerName - "claude" | "openai" | "codex" | "grok"
 * @param {string} [capability] - Optional capability check: "images" to verify image generation readiness
 * @returns {{ ready: boolean, reason: string|null }}
 */
export function isProviderReady(providerName, capability = null) {
  const canonicalName = canonicalProviderName(providerName);
  if (!isProviderEnabledByCatalog(canonicalName)) {
    return { ready: false, reason: `provider "${canonicalName}" is disabled by the model catalog` };
  }
  if (!providerRegistry.has(canonicalName)) {
    const loadErr = providerRegistry.getLoadError(canonicalName);
    return { ready: false, reason: providerLoadErrorReason(canonicalName, loadErr) };
  }
  if (capability === "images" && !isImageCapableProvider(canonicalName)) {
    return { ready: false, reason: `provider "${providerName}" does not support image generation` };
  }
  if (canonicalName === "claude") {
    const ready = providerRegistry.get("claude")?.isReady?.();
    return ready || { ready: false, reason: "claude provider not loaded" };
  }

  // Module loaded — now check credentials. Providers self-declare the env
  // vars they need via getCredentialEnvVars(); codex/claude expose richer
  // checks via isReady() and hasCredentials() because their auth flows are
  // not purely env-var-driven.
  const providerModule = providerRegistry.get(canonicalName);
  const envVars = typeof providerModule?.getCredentialEnvVars === "function"
    ? providerModule.getCredentialEnvVars()
    : [];
  for (const envVar of envVars) {
    if (!process.env[envVar]) {
      return { ready: false, reason: `${envVar} not set` };
    }
  }

  if (canonicalName === "codex") {
    const ready = providerModule?.isReady?.();
    if (ready && !ready.ready) return ready;
    if (typeof providerModule?.hasCredentials === "function" && !providerModule.hasCredentials()) {
      return { ready: false, reason: "Codex OAuth credentials not found (~/.codex/auth.json). API keys require codex_auth_mode=api." };
    }
  } else {
    if (typeof providerModule?.isReady === "function") {
      const ready = providerModule.isReady();
      if (ready && !ready.ready) return ready;
    }
    if (typeof providerModule?.hasCredentials === "function" && !providerModule.hasCredentials()) {
      return { ready: false, reason: `${canonicalName} credentials not found` };
    }
  }

  return { ready: true, reason: null };
}

export function isProviderSelectable(providerName) {
  const canonicalName = canonicalProviderName(providerName);
  if (!isProviderEnabledByCatalog(canonicalName)) return false;
  if (canonicalName === "claude") return isProviderReady("claude", null).ready;
  if (!providerRegistry.has(canonicalName)) return false;

  const mod = providerRegistry.get(canonicalName);
  if (typeof mod.hasCredentials === "function") {
    const ready = typeof mod.isReady === "function" ? mod.isReady() : { ready: true };
    return !!mod.hasCredentials() && !!ready.ready;
  }

  return isProviderReady(canonicalName, null).ready;
}

function _inferLimitTokens(usedTokens, observedPct) {
  const pct = Number(observedPct);
  const used = Number(usedTokens);
  if (!Number.isFinite(used) || used < 0) return null;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  const inferred = Math.ceil(used / (pct / 100));
  return Number.isFinite(inferred) && inferred > 0 ? Math.max(used, inferred) : null;
}

export function inferProviderWindowLimit(providerName, windowKey, observedPct, opts = {}) {
  const mod = resolveProviderModule(providerName);
  if (typeof mod.getUsageSummary !== "function") return null;
  const summary = mod.getUsageSummary(opts);
  const window = summary?.windows?.find((entry) => entry.key === windowKey);
  if (!window) return null;
  const limitTokens = _inferLimitTokens(window.usedTokens, observedPct);
  if (limitTokens == null) return null;
  return {
    provider: summary.provider,
    windowKey,
    observedPct: Number(observedPct),
    usedTokens: window.usedTokens || 0,
    limitTokens,
    remainingTokens: Math.max(0, limitTokens - (window.usedTokens || 0)),
    resetAt: window.resetAt || null,
  };
}

// ─── Boot-time Health Check ─────────────────────────────────────────────────

/**
 * Returns an array of { provider, status, detail } objects describing
 * the readiness of each configured provider. Call during scheduler boot.
 */
export function getProviderHealth() {
  const results = [];
  const imageProviders = [...new Set(getConfiguredImageProviders().map((name) => canonicalProviderName(name)).filter(Boolean))];
  const configuredProviders = new Set(
    PROVIDER_ROLE_NAMES
      .flatMap((role) => getAvailableProviders(role))
      .map((name) => canonicalProviderName(name))
      .filter(Boolean),
  );

  const healthRow = (providerName, { capability = null, suffix = "" } = {}) => {
    const canonical = canonicalProviderName(providerName);
    const ready = isProviderReady(canonical, capability);
    const loaded = providerRegistry.has(canonical);
    const status = ready.ready
      ? "available"
      : (!capability && canonical === "openai" && loaded ? "loaded (no credentials)" : "unavailable");
    return {
      provider: suffix ? `${canonical}-${suffix}` : canonical,
      status,
      detail: ready.ready ? null : ready.reason,
    };
  };

  for (const providerName of PROVIDER_OPTIONS) {
    if (configuredProviders.has(providerName)) results.push(healthRow(providerName));
  }
  for (const providerName of imageProviders) {
    results.push(healthRow(providerName, { capability: "images", suffix: "images" }));
  }

  return results;
}

// ─── Provider-Aware Rate Limit / Backoff ───────────────────────────────────

/**
 * Parse a provider error and return the recommended backoff in seconds.
 * Delegates to the provider module's parseErrorBackoff() if available,
 * otherwise falls back to conservative defaults.
 *
 * @param {string} providerName - "claude" | "openai" | etc.
 * @param {Error} err - The error from the provider call.
 * @returns {{ backoffSec: number, isRateLimit: boolean, source: string }}
 */
export function getProviderBackoff(providerName, err) {
  const mod = resolveProviderModule(providerName);
  if (mod.parseErrorBackoff) {
    const result = mod.parseErrorBackoff(err);
    if (
      result?.isRateLimit &&
      typeof mod.tripRateLimit === "function"
    ) {
      mod.tripRateLimit(result.backoffSec, result.source);
    }
    if (result?.isRateLimit) {
      persistRateLimitState(providerName, result.backoffSec, result.source);
    }
    return result;
  }
  // Fallback for providers without parseErrorBackoff
  const result = classifyProviderError(err, { defaultBackoffSec: 15 });
  if (result?.isRateLimit) {
    persistRateLimitState(providerName, result.backoffSec, result.source);
  }
  return result;
}

/**
 * Check if a provider is currently rate-limited (global state).
 * @param {string} providerName
 * @returns {{ blocked: boolean, retryInSec: number, reason: string }}
 */
export function getProviderRateLimitState(providerName) {
  const mod = resolveProviderModule(providerName);
  const persisted = readPersistedRateLimitState(providerName);
  if (mod.getRateLimitState) {
    const runtime = mod.getRateLimitState();
    if (persisted?.blocked && (!runtime?.blocked || persisted.retryInSec > (runtime.retryInSec || 0))) {
      return persisted;
    }
    return runtime;
  }
  if (persisted?.blocked) return persisted;
  return { blocked: false, retryInSec: 0, reason: "" };
}

// getProviderUsage / getProviderUsageAsync diverge on purpose: the sync twin
// reads the cached summary only (safe on render/boot paths), while the async
// twin prefers a network refresh before falling back to the cache. Collapsing
// them would either add network calls to sync paths or lose the refresh.
export function getProviderUsage(providerName, opts = {}) {
  const mod = resolveProviderModule(providerName);
  if (typeof mod.getUsageSummary === "function") {
    return mod.getUsageSummary(opts);
  }
  return null;
}

export async function getProviderUsageAsync(providerName, opts = {}) {
  const mod = resolveProviderModule(providerName);
  if (typeof mod.refreshUsageSummary === "function") {
    return await mod.refreshUsageSummary(opts);
  }
  if (typeof mod.getUsageSummary === "function") {
    return mod.getUsageSummary(opts);
  }
  return null;
}

export function getProviderCapacityState(providerName, opts = {}) {
  const readiness = isProviderReady(providerName, opts.capability || null);
  if (!readiness.ready) {
    return { blocked: true, reason: readiness.reason || "provider unavailable", source: "readiness", retryInSec: 0 };
  }

  const rateLimit = getProviderRateLimitState(providerName);
  if (rateLimit.blocked) {
    return {
      blocked: true,
      reason: rateLimit.reason || `${providerName} rate-limited`,
      source: "rate_limit",
      retryInSec: rateLimit.retryInSec || 0,
    };
  }

  const usage = getProviderUsage(providerName, opts);
  const exhaustedWindow = usage?.windows?.find((window) => window.limitTokens != null && (window.remainingTokens || 0) <= 0);
  if (exhaustedWindow) {
    const resetAt = exhaustedWindow.resetAt || null;
    return {
      blocked: true,
      reason: `${exhaustedWindow.label} token cap exhausted${resetAt ? ` until ${resetAt}` : ""}`,
      source: "usage_limit",
      retryInSec: resetAt ? Math.max(0, Math.ceil((Date.parse(resetAt) - (opts.nowMs || Date.now())) / 1000)) : 0,
    };
  }

  return { blocked: false, reason: "", source: "available", retryInSec: 0 };
}

// getConfiguredProviderUsage / *Async diverge on purpose: serial cached reads
// vs parallel refreshing fan-out — the fan-out shape is the semantics.
export function getConfiguredProviderUsage(opts = {}) {
  if (opts.primeAuth) {
    primeProviderUsageAuth({
      cwd: opts.cwd || null,
      timeoutMs: opts.primeAuthTimeoutMs,
      force: opts.forcePrimeAuth,
    });
  }
  const configuredProviders = getEffectiveUsageProviderSet();
  const summaries = [];

  for (const providerName of configuredProviders) {
    try {
      const summary = getProviderUsage(providerName, opts);
      if (summary) summaries.push(summary);
    } catch (err) {
      opts.onError?.(providerName, err);
    }
  }

  return summaries;
}

export async function getConfiguredProviderUsageAsync(opts = {}) {
  if (opts.primeAuth) {
    await primeProviderUsageAuthAsync({
      cwd: opts.cwd || null,
      timeoutMs: opts.primeAuthTimeoutMs,
      force: opts.forcePrimeAuth,
      preferInteractive: !!opts.preferInteractiveAuth,
      interactiveBackend: opts.interactiveBackend || null,
    });
  }
  const configuredProviders = getEffectiveUsageProviderSet();
  const results = await Promise.all([...configuredProviders].map(async (providerName) => {
    try {
      return await getProviderUsageAsync(providerName, opts);
    } catch (err) {
      opts.onError?.(providerName, err);
      return null;
    }
  }));

  return results.filter(Boolean);
}

// Shared head/tail for the prime-auth twins: they differ only in which warm
// call they make (sync warmOauthSession vs async warmOauthSessionAsync with
// interactive options).
function alreadyPrimedResult() {
  return {
    attempted: false,
    ok: true,
    skipped: "already-primed",
    providers: [],
  };
}

function finalizePrimeAuthResults(providerResults) {
  const attemptedResults = providerResults.filter((entry) => entry.attempted);
  const allOk = attemptedResults.every((entry) => entry.ok);
  providerRuntimeState.markUsageAuthPrimed(attemptedResults.length === 0 || allOk);
  return {
    attempted: attemptedResults.length > 0,
    ok: allOk,
    skipped: attemptedResults.length === 0 ? "no-auth-refresh-required" : null,
    providers: providerResults,
  };
}

export function primeProviderUsageAuth({ cwd = null, force = false, timeoutMs = 20_000 } = {}) {
  if (providerRuntimeState.isUsageAuthPrimed() && !force) return alreadyPrimedResult();

  const configuredProviders = getEffectiveUsageProviderSet();
  const providerResults = [];
  const claudeProvider = providerRegistry.get("claude");
  if (configuredProviders.has("claude") && typeof claudeProvider?.warmOauthSession === "function") {
    providerResults.push({
      provider: "claude",
      ...(claudeProvider.warmOauthSession({ cwd, timeoutMs }) || { attempted: false, ok: false, skipped: "unknown" }),
    });
  }

  return finalizePrimeAuthResults(providerResults);
}

export async function primeProviderUsageAuthAsync({
  cwd = null,
  force = false,
  timeoutMs = 20_000,
  preferInteractive = false,
  interactiveBackend = null,
} = {}) {
  if (providerRuntimeState.isUsageAuthPrimed() && !force) return alreadyPrimedResult();

  const configuredProviders = getEffectiveUsageProviderSet();
  const providerResults = [];
  const claudeProvider = providerRegistry.get("claude");
  if (configuredProviders.has("claude")) {
    if (typeof claudeProvider?.warmOauthSessionAsync === "function") {
      providerResults.push({
        provider: "claude",
        ...(await claudeProvider.warmOauthSessionAsync({
          cwd,
          timeoutMs,
          preferInteractive,
          interactiveBackend,
        }) || { attempted: false, ok: false, skipped: "unknown" }),
      });
    } else if (typeof claudeProvider?.warmOauthSession === "function") {
      providerResults.push({
        provider: "claude",
        ...(claudeProvider.warmOauthSession({ cwd, timeoutMs }) || { attempted: false, ok: false, skipped: "unknown" }),
      });
    }
  }

  return finalizePrimeAuthResults(providerResults);
}

export function __testResetProviderUsageAuthPrime() {
  assertTestContext("__testResetProviderUsageAuthPrime");
  providerRuntimeState.resetUsageAuthPrime();
}
