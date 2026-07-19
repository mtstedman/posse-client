import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_SETTING_DEFS,
  PROVIDER_OPTIONS,
  getDefaultTierModel,
  getImageModelOptions,
  getTextModelOptions,
} from "../../providers/functions/model-catalog.js";
import { providerRegistry } from "../../providers/functions/provider.js";
import {
  normalizePermissions as normalizeProjectDbPermissions,
  PROJECT_DB_TYPES,
} from "../../../shared/tools/functions/toolkit/project-db/config.js";
import {
  ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS,
  BOOLEAN_SETTING_KEYS,
  ENUM_SETTING_OPTIONS,
  MULTI_SETTING_KEYS,
  MULTI_SETTING_VALUES,
  NUMERIC_SETTING_RULES,
  PROJECT_DB_SETTING_KEYS,
  PROVIDER_SETTING_KEYS,
  SKILL_SETTING_PREFIX,
  toStorageSettingKey,
} from "./admin-catalog.js";
import { isCatalogKey } from "./catalog.js";

const MODEL_SETTING_KEYS = new Set(MODEL_SETTING_DEFS.map((def) => def.key));
const ADMIN_SETTING_VALUE_MAX_CHARS = 16_384;

export const PROTECTED_REMOTE_AUTH_SETTING_KEYS = new Set([
  "posse_native_heartbeat_url",
  "posse_native_heartbeat_public_key_url",
  "posse_native_heartbeat_jwt_public_key",
  "posse_native_heartbeat_jwt_public_key_sha256",
  "posse_native_heartbeat_jwt_audience",
]);

export function isAdminProviderOption(providerName) {
  const provider = String(providerName || "").trim().toLowerCase();
  if (!provider || !providerRegistry.has(provider)) return false;
  const mod = providerRegistry.get(provider);
  if (typeof mod?.hasCredentials === "function") {
    try { return !!mod.hasCredentials(); } catch { return false; }
  }
  // Claude has no cheap credential probe. Avoid launching a provider CLI just
  // to describe settings; its normal boot status remains the readiness owner.
  return true;
}

export function getSelectableProviders() {
  return PROVIDER_OPTIONS.filter((provider) => isAdminProviderOption(provider));
}

export function getSelectableImageProviders() {
  return IMAGE_PROVIDER_OPTIONS.filter((option) => isAdminProviderOption(option.value));
}

export function getModelChoicesForEntry(entry) {
  if (!entry) return [{ value: "", label: "(default: tier model)" }];
  const currentValue = entry.currentValue ?? entry.setting_value ?? "";
  if (entry.kind === "image") {
    return getImageModelOptions(entry.provider, { currentValue }).slice();
  }
  const baseChoices = getTextModelOptions(entry.provider, { includeDefault: true, currentValue });
  if (baseChoices.length === 0) return [{ value: "", label: "(default: tier model)" }];
  if (entry.provider === "claude" && entry.tier === "standard") {
    const defaultModel = getDefaultTierModel("claude", "standard") || "sonnet";
    return [{ value: "", label: `(default: ${defaultModel})` }, ...baseChoices.slice(1)];
  }
  return baseChoices.slice();
}

function normalizeNumericSettingValue(settingKey, value) {
  const key = toStorageSettingKey(settingKey);
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { ok: true, value: "" };

  let rule = NUMERIC_SETTING_RULES[key] || null;
  if (!rule && /^[a-z0-9]+_(?:account_)?limit_tokens_(?:session|week)$/i.test(key)) {
    rule = { integer: true, min: 0 };
  } else if (!rule && /^[a-z0-9]+_observed_pct_(?:session|week)$/i.test(key)) {
    rule = { integer: false, min: 0, max: 100 };
  }
  if (!rule) return { ok: true, value };

  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `${settingKey} must be a number.` };
  }
  const numberValue = Number(trimmed);
  if (!Number.isFinite(numberValue)) {
    return { ok: false, error: `${settingKey} must be finite.` };
  }
  if (rule.integer && !Number.isInteger(numberValue)) {
    return { ok: false, error: `${settingKey} must be an integer.` };
  }
  if (rule.min != null && numberValue < rule.min) {
    return { ok: false, error: `${settingKey} must be at least ${rule.min}.` };
  }
  if (rule.max != null && numberValue > rule.max) {
    return { ok: false, error: `${settingKey} must be at most ${rule.max}.` };
  }
  if (Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: `${settingKey} is too large to store safely.` };
  }
  return { ok: true, value: rule.integer ? String(Math.trunc(numberValue)) : String(numberValue) };
}

export function validateAdminSettingValue(settingKey, value) {
  const storageKey = toStorageSettingKey(String(settingKey || "").trim());
  if (!storageKey) return { ok: false, error: "Setting key is required." };
  const rawValue = String(value ?? "");
  const trimmed = rawValue.trim();

  if (rawValue.length > ADMIN_SETTING_VALUE_MAX_CHARS) {
    return { ok: false, error: `${settingKey} exceeds the ${ADMIN_SETTING_VALUE_MAX_CHARS}-character admin value limit.` };
  }

  if (PROTECTED_REMOTE_AUTH_SETTING_KEYS.has(storageKey)) {
    return {
      ok: false,
      error: `${settingKey} is managed by the compiled remote auth policy and cannot be changed through admin settings.`,
    };
  }

  if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
    if (storageKey === "project_db_enabled") {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") return { ok: false, error: "project_db_enabled must be true or false." };
      return { ok: true, storageKey, value: lower };
    }
    if (storageKey === "project_db_type") {
      if (trimmed === "") return { ok: true, storageKey, value: "" };
      const lower = trimmed.toLowerCase();
      if (!PROJECT_DB_TYPES.includes(lower)) return { ok: false, error: `project_db_type must be one of: ${PROJECT_DB_TYPES.join(", ")}` };
      return { ok: true, storageKey, value: lower };
    }
    if (storageKey === "project_db_permissions") {
      return { ok: true, storageKey, value: normalizeProjectDbPermissions(trimmed).join(",") };
    }
    if (storageKey === "project_db_port") {
      if (trimmed === "") return { ok: true, storageKey, value: "" };
      if (!/^\d+$/.test(trimmed)) return { ok: false, error: "project_db_port must be a number." };
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed)) return { ok: false, error: "project_db_port is too large to store safely." };
      return { ok: true, storageKey, value: trimmed };
    }
    // host / database / username / password: free text (password kept verbatim).
    return { ok: true, storageKey, value: rawValue };
  }

  if (storageKey.startsWith(SKILL_SETTING_PREFIX)) {
    const lower = trimmed.toLowerCase();
    if (lower !== "true" && lower !== "false") {
      return { ok: false, error: `${settingKey} must be true or false.` };
    }
    return { ok: true, storageKey, value: lower };
  }

  if (!isCatalogKey(storageKey) && !/^[a-z0-9]+_(?:account_)?limit_tokens_(?:session|week)$/i.test(storageKey) && !/^[a-z0-9]+_observed_pct_(?:session|week)$/i.test(storageKey)) {
    return { ok: false, error: `Unknown setting: ${settingKey}` };
  }

  if (PROVIDER_SETTING_KEYS.has(storageKey)) {
    if (trimmed === "") return { ok: true, storageKey, value: "" };
    const selectable = new Set(getSelectableProviders());
    const picked = [...new Set(trimmed.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
    const invalid = picked.filter((provider) => !selectable.has(provider));
    if (invalid.length > 0) {
      return { ok: false, error: `${settingKey} provider must be one of: ${[...selectable].join(", ") || "none available"}.` };
    }
    if (picked.length === 0) {
      return { ok: false, error: `${settingKey} requires at least one provider.` };
    }
    return { ok: true, storageKey, value: picked.join(",") };
  }

  if (ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(storageKey)) {
    if (trimmed === "") return { ok: true, storageKey, value: "" };
    const selectable = getSelectableImageProviders().map((option) => option.value);
    const provider = trimmed.toLowerCase();
    if (!selectable.includes(provider)) {
      return { ok: false, error: `${settingKey} must be one of: ${selectable.join(", ") || "none available"}.` };
    }
    return { ok: true, storageKey, value: provider };
  }

  const enumChoices = ENUM_SETTING_OPTIONS[storageKey];
  if (enumChoices) {
    const allowed = enumChoices.map((choice) => choice.value);
    const normalized = trimmed.toLowerCase();
    if (!allowed.includes(normalized)) {
      return { ok: false, error: `${settingKey} must be one of: ${allowed.join(", ")}.` };
    }
    return { ok: true, storageKey, value: normalized };
  }

  if (BOOLEAN_SETTING_KEYS.has(storageKey)) {
    const normalized = trimmed.toLowerCase();
    if (normalized !== "true" && normalized !== "false") {
      return { ok: false, error: `${settingKey} must be true or false.` };
    }
    return { ok: true, storageKey, value: normalized };
  }

  if (MULTI_SETTING_KEYS.has(storageKey)) {
    const allowed = MULTI_SETTING_VALUES[storageKey] || new Set();
    const picked = [...new Set(trimmed.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
    const invalid = picked.filter((entry) => !allowed.has(entry));
    if (invalid.length > 0 || picked.length === 0) {
      return { ok: false, error: `${settingKey} must include one or more of: ${[...allowed].join(", ")}.` };
    }
    return { ok: true, storageKey, value: picked.join(",") };
  }

  if (MODEL_SETTING_KEYS.has(storageKey)) {
    const def = MODEL_SETTING_DEFS.find((entry) => entry.key === storageKey);
    const allowed = getModelChoicesForEntry({ ...def, currentValue: rawValue }).map((choice) => choice.value);
    if (trimmed !== "" && !allowed.includes(trimmed)) {
      return { ok: false, error: `${settingKey} must be a configured model choice or empty for default.` };
    }
    return { ok: true, storageKey, value: trimmed };
  }

  const normalized = normalizeNumericSettingValue(storageKey, rawValue);
  if (!normalized.ok) return normalized;
  return { ok: true, storageKey, value: normalized.value };
}
