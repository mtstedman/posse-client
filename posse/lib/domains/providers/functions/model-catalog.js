import { MODEL_TIER_DEFAULTS, DEFAULT_TIER_MODEL_FALLBACK, TEXT_MODEL_CHOICES_INTERNAL, IMAGE_MODEL_CHOICES_INTERNAL, IMAGE_MODEL_NATIVE_FORMATS, TIER_LABELS } from "../../../catalog/provider-model-defaults.js";
export { CODEX_OAUTH_SUPPORTED_MODELS, CODEX_VALIDATION_KNOWN_MODELS } from "../../../catalog/provider-model-defaults.js";
// lib/provider/model-catalog.js
//
// Provider-specific model defaults and selectable model options. Pure enum
// data (provider identifiers, tier names, labels) lives in `lib/catalog/`
// and is re-exported here for backward compatibility; the tier-to-model
// defaults and helpers below stay co-located with the routing logic that
// uses them.
//
// Text models and image models are intentionally split to prevent cross-use.

import { PROVIDER_OPTIONS, PROVIDER_LABELS } from "../../../catalog/provider.js";
import { LOCAL_MODEL_IDS } from "../../../catalog/local-model.js";
import { MODEL_TIERS } from "../../../catalog/model.js";
import { getRemoteProviderCatalog } from "./model-catalog-store.js";

export { PROVIDER_OPTIONS, PROVIDER_LABELS, MODEL_TIERS };



export function getProviderTierDefaults(provider) {
  const key = String(provider || "").trim().toLowerCase();
  return MODEL_TIER_DEFAULTS[key] || {};
}

export function getDefaultTierModel(provider, tier) {
  const providerKey = String(provider || "").trim().toLowerCase();
  const tierKey = String(tier || "standard").trim().toLowerCase();
  // Remote catalog tier defaults win over the builtin mapping, but only when
  // the referenced model actually exists in the merged catalog. A remote
  // default of null means "provider default" — same as the builtin null.
  const remote = getRemoteProviderCatalog(providerKey);
  if (remote && tierKey in remote.tierDefaults) {
    const remoteDefault = remote.tierDefaults[tierKey];
    if (remoteDefault != null && getKnownTextModels(providerKey).has(remoteDefault)) {
      return remoteDefault;
    }
  }
  const providerDefaults = getProviderTierDefaults(providerKey);
  const direct = providerDefaults?.[tierKey]?.model;
  if (direct != null && String(direct).trim() !== "") return direct;
  return DEFAULT_TIER_MODEL_FALLBACK?.[providerKey]?.[tierKey] || null;
}




/** Native output formats of an image model, or null when the model is unknown. */
export function imageModelNativeFormats(model) {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return null;
  return IMAGE_MODEL_NATIVE_FORMATS.find((entry) => id.startsWith(entry.prefix))?.formats || null;
}

export function getDefaultImageProvider() {
  return Object.keys(IMAGE_MODEL_CHOICES_INTERNAL)[0] || "openai";
}

export function getDefaultImageModel(provider = null) {
  const key = String(provider || getDefaultImageProvider()).trim().toLowerCase();
  const models = IMAGE_MODEL_CHOICES_INTERNAL[key] || [];
  if (models.length > 0) return models[0];
  // No builtin image models for this provider — fall back to the remote
  // catalog before the hardcoded last resort.
  const remoteModels = getMergedImageModels(key);
  if (remoteModels.length > 0) return remoteModels[0];
  return key === "grok" ? "grok-imagine-image-quality" : "gpt-image-1.5";
}

export function normalizeGrokImageModelName(model = null) {
  const raw = String(model || "").trim().toLowerCase();
  if (!raw) return getDefaultImageModel("grok");
  const suffixFixed = raw.replace(
    /^(grok-imagine-image(?:-(?:quality(?:-(?:latest|\d{8}))?|pro|\d{4}-\d{2}-\d{2}))?)(?:-image)+$/,
    "$1",
  );
  if (getKnownImageModels("grok").has(suffixFixed)) return suffixFixed;
  return getDefaultImageModel("grok");
}

function asOption(value) {
  return Object.freeze({ value, label: value });
}

function buildModelOptionList(models, { includeDefault = false, defaultLabel = "(default: tier model)" } = {}) {
  const list = [];
  if (includeDefault) list.push({ value: "", label: defaultLabel });
  for (const model of models || []) list.push(asOption(model));
  return Object.freeze(list);
}

export const TEXT_MODEL_CHOICES_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(TEXT_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [provider, [...models]])
  )
);

export const IMAGE_MODEL_CHOICES_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(IMAGE_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [provider, [...models]])
  )
);

export const TEXT_MODEL_OPTIONS_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(TEXT_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [
      provider,
      buildModelOptionList(models, { includeDefault: true }),
    ])
  )
);

export const IMAGE_MODEL_OPTIONS_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(IMAGE_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [
      provider,
      buildModelOptionList(models, { includeDefault: false }),
    ])
  )
);

export const IMAGE_PROVIDER_OPTIONS = Object.freeze(
  Object.keys(IMAGE_MODEL_CHOICES_INTERNAL).map((provider) => Object.freeze({ value: provider, label: provider }))
);


function buildTextModelSettingDefs() {
  const defs = [];
  for (const provider of PROVIDER_OPTIONS) {
    for (const tier of MODEL_TIERS) {
      defs.push(Object.freeze({
        provider,
        key: `${provider}_model_${tier}`,
        label: `${PROVIDER_LABELS[provider]} ${tier} model`,
        description: `${TIER_LABELS[tier][0].toUpperCase()}${TIER_LABELS[tier].slice(1)} tier model for ${PROVIDER_LABELS[provider]}`,
        tier,
      }));
    }
  }
  return defs;
}

function buildImageModelSettingDefs() {
  const defs = [];
  for (const provider of Object.keys(IMAGE_MODEL_CHOICES_INTERNAL)) {
    defs.push(Object.freeze({
      provider,
      key: `${provider}_image_model`,
      label: `${PROVIDER_LABELS[provider]} image model`,
      description: `Image model for ${PROVIDER_LABELS[provider]} artifacts`,
      kind: "image",
    }));
  }
  return defs;
}

export const MODEL_SETTING_DEFS = Object.freeze([
  ...buildTextModelSettingDefs(),
  ...buildImageModelSettingDefs(),
]);



// ─── Merged catalog (builtin ∪ remote) ──────────────────────────────────────
//
// The builtin lists above are the offline baseline; the remote catalog cache
// (model-catalog-store.js) overlays them when posse-remote has been reached.
// Merge semantics:
//   - Builtin order is preserved; remote-only models append after.
//   - A remote entry matching a builtin id controls its deprecated flag.
//   - getMerged* exclude deprecated models (selection lists); getKnown* include
//     them plus aliases (membership checks for validation).

function remoteModelsForProvider(provider, kind) {
  const remote = getRemoteProviderCatalog(provider);
  if (!remote) return [];
  const models = (kind === "image" ? remote.imageModels : remote.textModels) || [];
  // Local execution requires an installed, client-supported profile. Older
  // remote catalogs must not restore suspended models or aliases.
  if (String(provider).trim().toLowerCase() === "posse-local" && kind === "text") {
    return models.filter(model => LOCAL_MODEL_IDS.includes(model.id)).map(model => ({
      ...model, aliases: (model.aliases || []).filter(alias => LOCAL_MODEL_IDS.includes(alias)),
    }));
  }
  return models;
}

function builtinModelsForProvider(provider, kind) {
  const source = kind === "image" ? IMAGE_MODEL_CHOICES_INTERNAL : TEXT_MODEL_CHOICES_INTERNAL;
  return source[String(provider || "").trim().toLowerCase()] || [];
}

function mergedModelList(provider, kind) {
  const key = String(provider || "").trim().toLowerCase();
  const builtin = builtinModelsForProvider(key, kind);
  const remoteModels = remoteModelsForProvider(key, kind);
  const remoteById = new Map(remoteModels.map((model) => [model.id, model]));
  const merged = [];
  const seen = new Set();
  for (const id of builtin) {
    const normalized = id.toLowerCase();
    seen.add(normalized);
    const remote = remoteById.get(normalized);
    if (remote?.deprecated) continue;
    merged.push(id);
  }
  for (const model of remoteModels) {
    if (model.deprecated || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model.id);
  }
  return merged;
}

function knownModelSet(provider, kind) {
  const key = String(provider || "").trim().toLowerCase();
  const known = new Set(builtinModelsForProvider(key, kind).map((id) => id.toLowerCase()));
  for (const model of remoteModelsForProvider(key, kind)) {
    known.add(model.id);
    for (const alias of model.aliases) known.add(alias);
  }
  return known;
}

/** Selectable (non-deprecated) text model ids: builtin order + remote appends. */
export function getMergedTextModels(provider) {
  return mergedModelList(provider, "text");
}

/** Selectable (non-deprecated) image model ids. */
export function getMergedImageModels(provider) {
  return mergedModelList(provider, "image");
}

/** All known text model ids (lowercase) including deprecated entries and aliases. */
export function getKnownTextModels(provider) {
  return knownModelSet(provider, "text");
}

/** All known image model ids (lowercase) including deprecated entries and aliases. */
export function getKnownImageModels(provider) {
  return knownModelSet(provider, "image");
}

/**
 * Catalog status for a configured model value.
 * @returns {{ known: boolean, deprecated: boolean, successor: string|null }}
 */
export function getModelCatalogStatus(provider, modelId, { kind = "text" } = {}) {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (!normalized) return { known: true, deprecated: false, successor: null };
  const known = knownModelSet(provider, kind);
  if (!known.has(normalized)) return { known: false, deprecated: false, successor: null };
  const remote = remoteModelsForProvider(provider, kind).find(
    (model) => model.id === normalized || model.aliases.includes(normalized),
  );
  return {
    known: true,
    deprecated: remote?.deprecated === true,
    successor: remote?.successor || null,
  };
}

function annotatedCurrentValueOption(provider, kind, currentValue) {
  const normalized = String(currentValue || "").trim();
  if (!normalized) return null;
  const status = getModelCatalogStatus(provider, normalized, { kind });
  // Only deprecated (catalog-known) values stay selectable with a note.
  // Unknown strings keep the pre-catalog behavior: dropdowns treat them as
  // unset, and runtime validation warns separately.
  if (!status.known || !status.deprecated) return null;
  return Object.freeze({ value: normalized, label: `${normalized} (deprecated)` });
}

/**
 * Option list for text model dropdowns, built from the merged catalog. The
 * configured value always stays selectable: stale values are appended with a
 * "(deprecated)" / "(not in catalog)" annotation rather than dropped.
 */
export function getTextModelOptions(provider, { includeDefault = true, defaultLabel = "(default: tier model)", currentValue = null } = {}) {
  const options = [...buildModelOptionList(getMergedTextModels(provider), { includeDefault, defaultLabel })];
  const annotated = annotatedCurrentValueOption(provider, "text", currentValue);
  if (annotated && !options.some((option) => option.value === annotated.value)) options.push(annotated);
  return Object.freeze(options);
}

/** Option list for image model dropdowns, built from the merged catalog. */
export function getImageModelOptions(provider, {
  currentValue = null,
  includeDefault = false,
  defaultLabel = "(default: provider image model)",
} = {}) {
  const options = [...buildModelOptionList(getMergedImageModels(provider), {
    includeDefault,
    defaultLabel,
  })];
  const annotated = annotatedCurrentValueOption(provider, "image", currentValue);
  if (annotated && !options.some((option) => option.value === annotated.value)) options.push(annotated);
  return Object.freeze(options);
}
