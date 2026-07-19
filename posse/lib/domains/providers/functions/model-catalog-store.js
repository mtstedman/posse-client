// lib/provider/model-catalog-store.js
//
// In-memory + persisted cache of the remote model catalog fetched from
// posse-remote's /v1/catalog/models. This module is the leaf of the catalog
// layering: model-catalog.js merges this data over its builtin lists and
// pricing.js consults the pricing map — neither direction loops back here.
//
// IMPORTANT: do not add a static import of the settings modules. The settings
// catalog evaluates model-catalog.js at module load, so a static
// store → account-settings edge would create an evaluation-order cycle
// (settings catalog → model-catalog → store → AccountSettings → settings
// catalog) that crashes with a TDZ error. The settings API is loaded lazily
// via dynamic import instead; until it resolves, readers see "no remote
// catalog" and fall back to builtin data.

import { PROVIDER_OPTIONS } from "../../../catalog/provider.js";
import { MODEL_TIERS } from "../../../catalog/model.js";

export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export const MODEL_CATALOG_SETTING_KEY = "model_catalog_json";
export const MODEL_CATALOG_FETCHED_AT_SETTING_KEY = "model_catalog_fetched_at";

const MAX_MODELS_PER_PROVIDER = 200;
const MAX_ALIASES_PER_MODEL = 8;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_CATALOG_VERSION_LENGTH = 100;
const MAX_PERSISTED_JSON_BYTES = 512 * 1024;
const MAX_PRICE_PER_MILLION_USD = 10_000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._\[\]:-]*$/i;

// undefined = not loaded yet; null = no usable remote catalog; object = catalog.
let _remoteCatalog;
// catalogVersion of the JSON payload known to be persisted in account
// settings. Tracked separately from the in-memory catalog so a fetch whose
// persist failed (oversize / settings write error) is retried instead of the
// version-unchanged branch stamping a fresh fetched_at over a missing row.
let _persistedCatalogVersion = null;
let _pricingMap = null;
let _settingsApi = null;
let _settingsApiPromise = null;

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeModelId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;
  if (!MODEL_ID_PATTERN.test(id)) return null;
  return id.toLowerCase();
}

function normalizePricing(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const input = Number(raw.input_per_million_usd);
  const output = Number(raw.output_per_million_usd);
  const validRate = (value) => Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_PER_MILLION_USD;
  if (!validRate(input) || !validRate(output)) return null;
  let cachedInput = null;
  if (raw.cached_input_per_million_usd != null) {
    const cached = Number(raw.cached_input_per_million_usd);
    if (validRate(cached)) cachedInput = cached;
  }
  return { input, output, cachedInput };
}

function normalizeModelEntry(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const id = normalizeModelId(raw.id);
  if (!id) return null;
  const aliases = [];
  if (Array.isArray(raw.aliases)) {
    for (const alias of raw.aliases.slice(0, MAX_ALIASES_PER_MODEL)) {
      const normalized = normalizeModelId(alias);
      if (normalized && normalized !== id && !aliases.includes(normalized)) aliases.push(normalized);
    }
  }
  const successor = raw.successor != null ? normalizeModelId(raw.successor) : null;
  const tierRaw = normalizeName(raw.tier);
  return {
    id,
    tier: MODEL_TIERS.includes(tierRaw) ? tierRaw : null,
    deprecated: raw.deprecated === true,
    aliases,
    successor,
    pricing: normalizePricing(raw.pricing),
  };
}

function normalizeModelList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const models = [];
  for (const raw of rawList) {
    if (models.length >= MAX_MODELS_PER_PROVIDER) break;
    const model = normalizeModelEntry(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function normalizeTierDefaults(raw) {
  const defaults = {};
  if (raw == null || typeof raw !== "object") return defaults;
  for (const tier of MODEL_TIERS) {
    if (!(tier in raw)) continue;
    const value = raw[tier];
    if (value == null) {
      defaults[tier] = null;
      continue;
    }
    const normalized = normalizeModelId(value);
    if (normalized) defaults[tier] = normalized;
  }
  return defaults;
}

function normalizeListing(raw) {
  if (raw == null || typeof raw !== "object") return { source: "curated", checkedAt: null, live: false };
  return {
    source: normalizeName(raw.source) || "curated",
    checkedAt: typeof raw.checked_at === "string" ? raw.checked_at : null,
    live: raw.live === true,
  };
}

/**
 * Validate and normalize a raw /v1/catalog/models payload into the internal
 * catalog shape. Returns null when the payload is structurally unusable
 * (wrong schema_version, missing catalog_version, or no valid providers).
 * Unknown fields are dropped; unknown providers are ignored; a provider with
 * no valid text models is dropped (an emptied provider is treated as
 * malformed rather than "everything was retired").
 */
export function normalizeRemoteModelCatalog(raw) {
  if (raw == null || typeof raw !== "object") return null;
  if (raw.schema_version !== MODEL_CATALOG_SCHEMA_VERSION) return null;
  const catalogVersion = String(raw.catalog_version ?? "").trim();
  if (!catalogVersion || catalogVersion.length > MAX_CATALOG_VERSION_LENGTH) return null;
  const rawProviders = raw.providers;
  if (rawProviders == null || typeof rawProviders !== "object") return null;

  const providers = {};
  for (const provider of PROVIDER_OPTIONS) {
    const entry = rawProviders[provider];
    if (entry == null || typeof entry !== "object") continue;
    const textModels = normalizeModelList(entry.text_models);
    if (textModels.length === 0) continue;
    providers[provider] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
      tierDefaults: normalizeTierDefaults(entry.tier_defaults),
      textModels,
      imageModels: normalizeModelList(entry.image_models),
      listing: normalizeListing(entry.listing),
    };
  }
  if (Object.keys(providers).length === 0) return null;

  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : null,
    providers,
  };
}

function ensureSettingsApiLoading() {
  if (_settingsApi || _settingsApiPromise) return _settingsApiPromise;
  _settingsApiPromise = import("../../settings/functions/account-settings.js")
    .then((mod) => {
      _settingsApi = mod;
      return mod;
    })
    .catch(() => {
      _settingsApiPromise = null;
      return null;
    });
  return _settingsApiPromise;
}

/**
 * Revive the persisted internal-shape catalog (what setRemoteCatalog stored).
 * Light sanity validation only — the payload was sanitized before persisting.
 * Returns null on any structural surprise.
 */
function reviveStoredCatalog(parsed) {
  if (parsed == null || typeof parsed !== "object") return null;
  if (parsed.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) return null;
  const catalogVersion = String(parsed.catalogVersion ?? "").trim();
  if (!catalogVersion) return null;
  if (parsed.providers == null || typeof parsed.providers !== "object") return null;
  const providers = {};
  for (const provider of PROVIDER_OPTIONS) {
    const entry = parsed.providers[provider];
    if (entry == null || typeof entry !== "object") continue;
    if (!Array.isArray(entry.textModels) || entry.textModels.length === 0) continue;
    const validModel = (model) => model != null && typeof model === "object" && typeof model.id === "string" && model.id !== "";
    providers[provider] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
      tierDefaults: entry.tierDefaults != null && typeof entry.tierDefaults === "object" ? entry.tierDefaults : {},
      textModels: entry.textModels.filter(validModel).map((model) => ({
        id: model.id,
        tier: MODEL_TIERS.includes(model.tier) ? model.tier : null,
        deprecated: model.deprecated === true,
        aliases: Array.isArray(model.aliases) ? model.aliases.filter((alias) => typeof alias === "string") : [],
        successor: typeof model.successor === "string" ? model.successor : null,
        pricing: normalizeStoredPricing(model.pricing),
      })),
      imageModels: Array.isArray(entry.imageModels)
        ? entry.imageModels.filter(validModel).map((model) => ({
            id: model.id,
            tier: null,
            deprecated: model.deprecated === true,
            aliases: Array.isArray(model.aliases) ? model.aliases.filter((alias) => typeof alias === "string") : [],
            successor: typeof model.successor === "string" ? model.successor : null,
            pricing: normalizeStoredPricing(model.pricing),
          }))
        : [],
      listing: entry.listing != null && typeof entry.listing === "object"
        ? entry.listing
        : { source: "curated", checkedAt: null, live: false },
    };
  }
  if (Object.keys(providers).length === 0) return null;
  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
    providers,
  };
}

function normalizeStoredPricing(pricing) {
  if (pricing == null || typeof pricing !== "object") return null;
  const input = Number(pricing.input);
  const output = Number(pricing.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cachedInput = Number(pricing.cachedInput);
  return { input, output, cachedInput: Number.isFinite(cachedInput) ? cachedInput : null };
}

function loadFromSettings() {
  if (!_settingsApi) return;
  try {
    const json = _settingsApi.getAccountSetting(MODEL_CATALOG_SETTING_KEY);
    _remoteCatalog = json ? reviveStoredCatalog(JSON.parse(json)) : null;
    _persistedCatalogVersion = _remoteCatalog?.catalogVersion ?? null;
  } catch {
    _remoteCatalog = null;
    _persistedCatalogVersion = null;
  }
  _pricingMap = null;
}

/**
 * Await the persisted remote catalog being loaded (or confirmed absent).
 * Boot and refresh paths call this before validating configured models so
 * the first validation pass sees the cached catalog.
 */
export async function ensureRemoteCatalogLoaded() {
  if (_remoteCatalog !== undefined) return _remoteCatalog;
  await ensureSettingsApiLoading();
  if (_remoteCatalog === undefined) loadFromSettings();
  return _remoteCatalog ?? null;
}

/**
 * Current remote catalog, or null when none is available yet. Synchronous and
 * non-blocking: before the lazy settings import resolves this returns null
 * (builtin-only) and kicks the load off in the background.
 */
export function getRemoteCatalog() {
  if (_remoteCatalog !== undefined) return _remoteCatalog;
  if (_settingsApi) {
    loadFromSettings();
    return _remoteCatalog;
  }
  const pending = ensureSettingsApiLoading();
  if (pending) pending.then(() => { if (_remoteCatalog === undefined) loadFromSettings(); });
  return null;
}

export function getRemoteProviderCatalog(provider) {
  const catalog = getRemoteCatalog();
  if (!catalog) return null;
  return catalog.providers[normalizeName(provider)] || null;
}

/**
 * Whether the signed remote model catalog permits selecting a provider for
 * generation. Existing cloud providers stay enabled when an older cached
 * catalog lacks the additive flag. The pre-release local provider is
 * intentionally fail-closed until the catalog explicitly enables it.
 */
export function isProviderEnabledByCatalog(provider) {
  const normalized = normalizeName(provider);
  const entry = getRemoteProviderCatalog(normalized);
  if (entry?.enabled === true) return true;
  if (entry?.enabled === false) return false;
  return normalized !== "posse-local";
}

/**
 * Install a normalized catalog (from a successful remote fetch) and
 * optionally persist it to account settings. Persistence is skipped when the
 * catalog version is unchanged (avoids account.db churn) or when the
 * serialized payload exceeds the size cap. Returns { persisted }.
 */
export function setRemoteCatalog(normalized, { persist = true, fetchedAt = null } = {}) {
  _remoteCatalog = normalized ?? null;
  _pricingMap = null;
  if (!persist || !normalized) return { persisted: false };
  if (!_settingsApi) {
    ensureSettingsApiLoading();
    if (!_settingsApi) return { persisted: false };
  }
  try {
    const timestamp = fetchedAt || new Date().toISOString();
    if (normalized.catalogVersion !== _persistedCatalogVersion) {
      const json = JSON.stringify(normalized);
      if (Buffer.byteLength(json, "utf8") > MAX_PERSISTED_JSON_BYTES) return { persisted: false };
      _settingsApi.setAccountSetting(MODEL_CATALOG_SETTING_KEY, json);
      _persistedCatalogVersion = normalized.catalogVersion;
    }
    _settingsApi.setAccountSetting(MODEL_CATALOG_FETCHED_AT_SETTING_KEY, timestamp);
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

/** Drop the in-memory catalog so the next read reloads from account settings. */
export function invalidateRemoteModelCatalog() {
  _remoteCatalog = undefined;
  _pricingMap = null;
}

/**
 * Map of "provider:model" → { input, output, cachedInput } built from the
 * remote catalog (alias keys included). Null when no remote catalog is
 * available — pricing falls through to builtin defaults.
 */
export function getRemotePricingMap() {
  const catalog = getRemoteCatalog();
  if (!catalog) return null;
  if (_pricingMap) return _pricingMap;
  const map = new Map();
  for (const [provider, entry] of Object.entries(catalog.providers)) {
    for (const model of [...entry.textModels, ...entry.imageModels]) {
      if (!model.pricing) continue;
      map.set(`${provider}:${model.id}`, model.pricing);
      for (const alias of model.aliases) {
        const key = `${provider}:${alias}`;
        if (!map.has(key)) map.set(key, model.pricing);
      }
    }
  }
  _pricingMap = map;
  return _pricingMap;
}

/**
 * Test seam: install a catalog (already-normalized internal shape or null)
 * without touching the settings DB.
 */
export function setRemoteCatalogForTest(catalog = null) {
  _remoteCatalog = catalog;
  _pricingMap = null;
}

export function __resetRemoteModelCatalogStoreForTests() {
  _remoteCatalog = undefined;
  _persistedCatalogVersion = null;
  _pricingMap = null;
  _settingsApi = null;
  _settingsApiPromise = null;
}
