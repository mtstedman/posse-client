// @ts-check
import { MODEL_CATALOG_SCHEMA_VERSION, MAX_MODELS_PER_PROVIDER, MAX_ALIASES_PER_MODEL, MAX_MODEL_ID_LENGTH, MAX_CATALOG_VERSION_LENGTH, MAX_PRICE_PER_MILLION_USD, MODEL_ID_PATTERN } from "../../../catalog/remote-model-catalog.js";
export { MODEL_CATALOG_SCHEMA_VERSION, MODEL_CATALOG_SETTING_KEY, MODEL_CATALOG_FETCHED_AT_SETTING_KEY, MAX_MODELS_PER_PROVIDER, MAX_ALIASES_PER_MODEL, MAX_MODEL_ID_LENGTH, MAX_CATALOG_VERSION_LENGTH, MAX_PERSISTED_JSON_BYTES, MAX_PRICE_PER_MILLION_USD, MODEL_ID_PATTERN } from "../../../catalog/remote-model-catalog.js";

import { PROVIDER_OPTIONS } from "../../../catalog/provider.js";
import { MODEL_TIERS } from "../../../catalog/model.js";











export function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeModelId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;
  if (!MODEL_ID_PATTERN.test(id)) return null;
  return id.toLowerCase();
}

export function normalizePricing(raw) {
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

export function normalizeModelEntry(raw) {
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

export function normalizeModelList(rawList) {
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

export function normalizeTierDefaults(raw) {
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

export function normalizeListing(raw) {
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

/**
 * Revive the persisted internal-shape catalog (what setRemoteCatalog stored).
 * Light sanity validation only — the payload was sanitized before persisting.
 * Returns null on any structural surprise.
 */
export function reviveStoredCatalog(parsed) {
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

export function normalizeStoredPricing(pricing) {
  if (pricing == null || typeof pricing !== "object") return null;
  const input = Number(pricing.input);
  const output = Number(pricing.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cachedInput = Number(pricing.cachedInput);
  return { input, output, cachedInput: Number.isFinite(cachedInput) ? cachedInput : null };
}
