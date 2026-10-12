import { SETTING_DEFINITIONS } from "../../../catalog/setting-definitions.js";
// Runtime projection of canonical account setting definitions.
//
// Add settings in lib/catalog/setting-definitions.js. Defaults seed account.db
// on first open via INSERT OR IGNORE, so every key is visible immediately.
//
// Conventions:
// - default: empty string ("") means "no override; let calling code use its
//   computed fallback or a provider/tier default". A non-empty default
//   ("true", "4", "claude") becomes the actual value used at runtime.
// - description: shown in admin TUI and used to document settings on disk.
// - adminVisible: false documents internal settings that must stay hidden
//   while remaining available to runtime code. Otherwise catalog entries are
//   admin-visible by default, and specialized admin sections can still filter
//   provider/model/internal rows into their own renderers.

import { PROVIDER_LABELS, getDefaultTierModel } from "../../providers/functions/model-catalog.js";
import "../../providers/functions/roles.js";

// Value enums for individual settings live in the catalogue (split by domain
// — generic settings in lib/catalog/settings.js, ATLAS-specific in
// lib/catalog/atlas.js). Imported here for use inside SETTINGS_CATALOG below
// and re-exported so admin UI / validation imports keep their existing paths.
import { AGENT_COORDINATION_MODE_VALUES, ASSESSMENT_SCOPE_MODE_VALUES, CODEX_AUTH_MODE_OPTIONS, CONTEXT_COMPACTION_MODE_VALUES, FIX_SCOPE_HANDOFF_GUARD_VALUES, GIT_COMMIT_STYLE_VALUES, HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES, KAIZEN_TO_ATLAS_MODE_VALUES, LOG_LEVEL_VALUES, MODEL_CATALOG_ENFORCEMENT_VALUES, PLAN_APPROVAL_MODES, PLAN_APPROVAL_MODE_VALUES, PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES, RESEARCH_FANOUT_MODE_VALUES, RESEARCH_EVIDENCE_REUSE_MODE_VALUES, RESEARCH_TRAVERSAL_COMPLETION_MODE_VALUES, RESEARCH_BUDGET_VISIBILITY_VALUES, ATLAS_SHADOW_GUARDRAILS_MODE_VALUES, ATLAS_HANDOFF_PREFETCH_MODE_VALUES, ATLAS_RESEARCH_PREFETCH_FOCUS_MODE_VALUES, ATLAS_MEMORY_SURFACE_MODE_VALUES, SESSION_RECYCLE_MODE_VALUES, STARTUP_DIRTY_TREE_POLICY_VALUES, WAITING_LANE_SHADOW_MODE_VALUES } from "../../../catalog/settings.js";
import { ATLAS_AUTO_FEEDBACK_VALUES, ATLAS_BOOT_REINDEX_POLICY_VALUES, ATLAS_EMBEDDING_MODEL_OPTIONS, DEFAULT_ATLAS_EMBEDDING_MODEL_ID, ATLAS_PHASE_VALUES, ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT, ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES, ATLAS_SCIP_LANGUAGE_OPTIONS, ATLAS_SCIP_LANGUAGE_VALUES, ATLAS_SCIP_MODE_VALUES, ATLAS_SCIP_RESTAGE_POLICY_VALUES, ATLAS_TREE_COMPRESSION_MODE_VALUES, ATLAS_TRANSPORT_VALUES, ATLAS_V2_MODE_VALUES } from "../../../catalog/atlas.js";

export {
  AGENT_COORDINATION_MODE_VALUES,
  ASSESSMENT_SCOPE_MODE_VALUES,
  CODEX_AUTH_MODE_OPTIONS,
  CONTEXT_COMPACTION_MODE_VALUES,
  FIX_SCOPE_HANDOFF_GUARD_VALUES,
  GIT_COMMIT_STYLE_VALUES,
  HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES,
  KAIZEN_TO_ATLAS_MODE_VALUES,
  LOG_LEVEL_VALUES,
  MODEL_CATALOG_ENFORCEMENT_VALUES,
  PLAN_APPROVAL_MODES,
  PLAN_APPROVAL_MODE_VALUES,
  PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES,
  RESEARCH_FANOUT_MODE_VALUES,
  RESEARCH_EVIDENCE_REUSE_MODE_VALUES,
  RESEARCH_TRAVERSAL_COMPLETION_MODE_VALUES,
  RESEARCH_BUDGET_VISIBILITY_VALUES,
  ATLAS_SHADOW_GUARDRAILS_MODE_VALUES,
  ATLAS_HANDOFF_PREFETCH_MODE_VALUES,
  ATLAS_RESEARCH_PREFETCH_FOCUS_MODE_VALUES,
  ATLAS_MEMORY_SURFACE_MODE_VALUES,
  SESSION_RECYCLE_MODE_VALUES,
  STARTUP_DIRTY_TREE_POLICY_VALUES,
  WAITING_LANE_SHADOW_MODE_VALUES,
  ATLAS_AUTO_FEEDBACK_VALUES,
  ATLAS_BOOT_REINDEX_POLICY_VALUES,
  ATLAS_EMBEDDING_MODEL_OPTIONS,
  DEFAULT_ATLAS_EMBEDDING_MODEL_ID,
  ATLAS_PHASE_VALUES,
  ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES,
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  ATLAS_SCIP_MODE_VALUES,
  ATLAS_SCIP_RESTAGE_POLICY_VALUES,
  ATLAS_TREE_COMPRESSION_MODE_VALUES,
  ATLAS_TRANSPORT_VALUES,
  ATLAS_V2_MODE_VALUES,
};




// Runtime display descriptions may mention a validated remote tier default.
// Identity, value policy, and persisted defaults always come from pure data.
export const SETTINGS_CATALOG = SETTING_DEFINITIONS.map((entry) => {
  const match = entry.key.match(/^(.*)_model_(cheap|standard|strong)$/);
  if (!match) return entry;
  const [, provider, tier] = match;
  const model = getDefaultTierModel(provider, tier);
  return { ...entry, description: `${PROVIDER_LABELS[provider]} model for ${tier} tier${model ? ` (empty = ${model})` : ""}` };
});

// Quick-lookup map: key → default value.
export const SETTINGS_DEFAULTS = Object.freeze(
  Object.fromEntries(SETTINGS_CATALOG.map((entry) => [entry.key, entry.default])),
);

const OPTION_LABEL_OVERRIDES = Object.freeze({
  js: "JavaScript",
  ml: "ML",
  scip: "SCIP",
  onnx: "ONNX",
  on_demand: "On demand",
  "dev-fix": "Dev/fix",
  warn_and_fallback: "Warn and fallback",
  warn_only: "Warn only",
});

function humanizeCatalogOptionLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  if (OPTION_LABEL_OVERRIDES[lower]) return OPTION_LABEL_OVERRIDES[lower];
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\b(api|cli|db|fts|http|json|mcp|ml|onnx|pty|scip|sql|ui|url|wi|usd)\b/gi, (word) => word.toUpperCase())
    .replace(/^\w/, (ch) => ch.toUpperCase());
}

function normalizeCatalogOption(option) {
  if (option && typeof option === "object") {
    const value = String(option.value ?? "").trim();
    if (!value) return null;
    return Object.freeze({ value, label: String(option.label ?? humanizeCatalogOptionLabel(value)) });
  }
  const value = String(option ?? "").trim();
  return value ? Object.freeze({ value, label: humanizeCatalogOptionLabel(value) }) : null;
}

export function getCatalogEntry(key) {
  return SETTINGS_CATALOG.find((entry) => entry.key === key) || null;
}

export function getCatalogDefault(key) {
  const entry = getCatalogEntry(key);
  return entry ? entry.default : null;
}

export function getCatalogOptions(key) {
  const entry = getCatalogEntry(key);
  const options = Array.isArray(entry?.options) ? entry.options : [];
  return Object.freeze(options.map(normalizeCatalogOption).filter(Boolean));
}

export function getCatalogOptionValues(key) {
  return Object.freeze(getCatalogOptions(key).map((option) => option.value));
}

export function isCatalogBooleanSetting(key) {
  const entry = getCatalogEntry(key);
  if (!entry) return false;
  if (entry.valueType === "boolean") return true;
  const value = String(entry.default ?? "").trim().toLowerCase();
  return value === "true" || value === "false";
}

function getDynamicNumericRule(key) {
  const normalizedKey = String(key || "");
  if (/^[a-z0-9]+_(?:account_)?limit_tokens_(?:session|week)$/i.test(normalizedKey)) {
    return { integer: true, min: 0 };
  }
  if (/^[a-z0-9]+_observed_pct_(?:session|week)$/i.test(normalizedKey)) {
    return { integer: false, min: 0, max: 100 };
  }
  return null;
}

export function getCatalogNumericRule(key) {
  const entry = getCatalogEntry(key);
  const rule = entry?.numeric || getDynamicNumericRule(key);
  return rule ? Object.freeze({ ...rule }) : null;
}

function normalizeCatalogBooleanValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return "true";
  if (["false", "0", "no", "off"].includes(normalized)) return "false";
  return null;
}

function validateCatalogNumericValue(key, value, rule) {
  const trimmed = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `${key} must be a number.` };
  }
  const numberValue = Number(trimmed);
  if (!Number.isFinite(numberValue)) {
    return { ok: false, error: `${key} must be finite.` };
  }
  if (rule.integer && !Number.isInteger(numberValue)) {
    return { ok: false, error: `${key} must be an integer.` };
  }
  if (rule.min != null && numberValue < rule.min) {
    return { ok: false, error: `${key} must be at least ${rule.min}.` };
  }
  if (rule.max != null && numberValue > rule.max) {
    return { ok: false, error: `${key} must be at most ${rule.max}.` };
  }
  if (Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: `${key} is too large to store safely.` };
  }
  return { ok: true, value: rule.integer ? String(Math.trunc(numberValue)) : String(numberValue) };
}

export function validateCatalogSettingValue(key, value, { allowUnknown = true } = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return { ok: false, error: "Setting key is required." };
  const entry = getCatalogEntry(normalizedKey);
  const dynamicNumericRule = getDynamicNumericRule(normalizedKey);
  if (!entry && !dynamicNumericRule) {
    return allowUnknown
      ? { ok: true, key: normalizedKey, value: String(value ?? "") }
      : { ok: false, error: `Unknown setting: ${normalizedKey}` };
  }

  const rawValue = String(value ?? "");
  const trimmed = rawValue.trim();
  if (trimmed === "") return { ok: true, key: normalizedKey, value: "" };

  const options = getCatalogOptions(normalizedKey);
  if (options.length > 0) {
    const allowed = new Set(options.map((option) => option.value));
    if (entry.multi) {
      const picked = [...new Set(trimmed.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean))];
      const invalid = picked.filter((part) => !allowed.has(part));
      if (invalid.length > 0 || picked.length === 0) {
        return { ok: false, error: `${normalizedKey} must include one or more of: ${[...allowed].join(", ")}.` };
      }
      return { ok: true, key: normalizedKey, value: picked.join(",") };
    }
    const normalized = trimmed.toLowerCase();
    if (!allowed.has(normalized)) {
      return { ok: false, error: `${normalizedKey} must be one of: ${[...allowed].join(", ")}.` };
    }
    return { ok: true, key: normalizedKey, value: normalized };
  }

  if (isCatalogBooleanSetting(normalizedKey)) {
    const normalized = normalizeCatalogBooleanValue(trimmed);
    if (normalized == null) return { ok: false, error: `${normalizedKey} must be true or false.` };
    return { ok: true, key: normalizedKey, value: normalized };
  }

  const numericRule = getCatalogNumericRule(normalizedKey);
  if (numericRule) {
    const numeric = validateCatalogNumericValue(normalizedKey, trimmed, numericRule);
    return numeric.ok ? { ok: true, key: normalizedKey, value: numeric.value } : numeric;
  }

  return { ok: true, key: normalizedKey, value: rawValue };
}

export function getCatalogRuntimeFallback(key) {
  const entry = getCatalogEntry(key);
  if (!entry) return null;
  const fallback = entry.runtimeFallback ?? entry.default;
  return fallback == null || String(fallback).trim() === "" ? null : String(fallback);
}

export function getCatalogRuntimeFallbackInt(key, fallback = null) {
  const raw = getCatalogRuntimeFallback(key);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isCatalogKey(key) {
  return SETTINGS_CATALOG.some((entry) => entry.key === key);
}

export function isAdminVisibleCatalogKey(key) {
  const entry = getCatalogEntry(key);
  return !!entry && entry.adminVisible !== false;
}
