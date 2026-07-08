import { SETTING_KEYS } from "../../../catalog/settings.js";

export const CONTEXT_COMPACTION_DEFAULTS = Object.freeze({
  mode: "shadow",
  triggerInputTokens: 32_000,
  sessionResetInputTokens: 96_000,
  recentTargetTokens: 12_000,
});

const CONTEXT_COMPACTION_KEYS = Object.freeze({
  mode: SETTING_KEYS.CONTEXT_COMPACTION_MODE,
  triggerInputTokens: SETTING_KEYS.CONTEXT_COMPACTION_TRIGGER_INPUT_TOKENS,
  sessionResetInputTokens: SETTING_KEYS.CONTEXT_COMPACTION_SESSION_RESET_INPUT_TOKENS,
  recentTargetTokens: SETTING_KEYS.CONTEXT_COMPACTION_RECENT_TARGET_TOKENS,
});

const CONTEXT_COMPACTION_ALIASES = Object.freeze({
  mode: ["mode", "contextCompactionMode"],
  triggerInputTokens: ["triggerInputTokens", "trigger_input_tokens", "pressureInputTokens", "pressure_input_tokens"],
  sessionResetInputTokens: ["sessionResetInputTokens", "session_reset_input_tokens"],
  recentTargetTokens: ["recentTargetTokens", "recent_target_tokens"],
});

export function estimateTokensFromChars(value) {
  const chars = typeof value === "string" ? value.length : Number(value) || 0;
  return Math.max(0, Math.ceil(chars / 4));
}

export function normalizeContextCompactionMode(value) {
  const raw = String(value || CONTEXT_COMPACTION_DEFAULTS.mode).trim().toLowerCase();
  return ["off", "shadow", "inject", "enforce"].includes(raw) ? raw : CONTEXT_COMPACTION_DEFAULTS.mode;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readIntegerSetting(readSetting, key, fallback) {
  try {
    const parsed = positiveInteger(readSetting?.(key));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readWorkItemSafe({ workItem = null, workItemId = null, readWorkItem = null } = {}) {
  if (workItem && typeof workItem === "object") return workItem;
  if (workItemId == null || typeof readWorkItem !== "function") return null;
  try {
    return readWorkItem(workItemId) || null;
  } catch {
    return null;
  }
}

function candidateOverrideObjects(metadata) {
  const experiment = metadata.experiment && typeof metadata.experiment === "object"
    ? metadata.experiment
    : null;
  return [
    metadata.context_compaction,
    metadata.contextCompaction,
    metadata.ab_context_compaction,
    experiment?.context_compaction,
    experiment?.contextCompaction,
    experiment?.settings,
    metadata.ab_settings,
  ].filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function pickOverride(overrideObjects, settingKey, aliases = []) {
  for (const overrides of overrideObjects) {
    if (Object.prototype.hasOwnProperty.call(overrides, settingKey)) return overrides[settingKey];
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(overrides, alias)) return overrides[alias];
    }
  }
  return undefined;
}

function contextCompactionOverridesForWorkItem(opts = {}) {
  const workItem = readWorkItemSafe(opts);
  const metadata = parseJsonObject(workItem?.metadata_json);
  const overrideObjects = candidateOverrideObjects(metadata);
  if (overrideObjects.length === 0) return {};

  const out = {};
  for (const [name, settingKey] of Object.entries(CONTEXT_COMPACTION_KEYS)) {
    const value = pickOverride(overrideObjects, settingKey, CONTEXT_COMPACTION_ALIASES[name] || []);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function readMode(readSetting, overrides) {
  if (Object.prototype.hasOwnProperty.call(overrides, "mode")) {
    return normalizeContextCompactionMode(overrides.mode);
  }
  try {
    return normalizeContextCompactionMode(readSetting?.(SETTING_KEYS.CONTEXT_COMPACTION_MODE));
  } catch {
    return CONTEXT_COMPACTION_DEFAULTS.mode;
  }
}

function readIntegerConfig(readSetting, overrides, name) {
  const fallback = CONTEXT_COMPACTION_DEFAULTS[name];
  const override = Object.prototype.hasOwnProperty.call(overrides, name)
    ? positiveInteger(overrides[name])
    : null;
  if (override != null) return override;
  return readIntegerSetting(readSetting, CONTEXT_COMPACTION_KEYS[name], fallback);
}

export function resolveContextCompactionConfig({
  readSetting = null,
  readWorkItem = null,
  workItem = null,
  workItemId = null,
} = {}) {
  const overrides = contextCompactionOverridesForWorkItem({ workItem, workItemId, readWorkItem });
  const hasOverrides = Object.keys(overrides).length > 0;
  return {
    mode: readMode(readSetting, overrides),
    triggerInputTokens: readIntegerConfig(readSetting, overrides, "triggerInputTokens"),
    sessionResetInputTokens: readIntegerConfig(readSetting, overrides, "sessionResetInputTokens"),
    recentTargetTokens: readIntegerConfig(readSetting, overrides, "recentTargetTokens"),
    source: hasOverrides ? "work_item_metadata" : "account_settings",
  };
}
