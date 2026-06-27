// lib/admin.js — Admin TUI for stats, work-item logs, and settings management
//
// Standalone TUI that uses alternate screen + raw mode.
// Tabs: Overview | Work Items | Settings | ATLAS Report | Prompts
// Navigation: 1-5 or Tab to switch, ↑↓ to scroll/select, Enter to drill in, Esc/Bksp to back up, 'e' to edit settings.

import readline from "readline";
import {
  buildProviderUsageWindowMap,
  clipPlainTail,
  correspondingLimitSettingKey,
  finiteNumber,
  fit,
  fmtDate,
  formatModelSettingDisplayValue,
  formatProviderSettingValue,
  formatProviderUsageHeader,
  formatProviderUsageWindow,
  getModelProviderDefaults,
  getPrintableInput,
  getProviderUsageSettingHint,
  isBackspaceKey,
  isBooleanSettingValue,
  isEnterKey,
  loadIndexedReport,
  loadReportIndex,
  loadReports,
  matchesHotkey,
  normalizeNumericSettingValue,
  normalizeRawInput,
  parseJsonObject,
  parseProviderList,
  parseProviderUsageSettingKey,
  parseReportTimestamp,
  renderUsageBar,
  runtimeDbLooksBusyOrCorrupt,
  toDisplaySettingEntry,
  visibleLength,
} from "../../functions/admin/shared-helpers.js";
import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  listWorkItems,
  listJobs,
  getAgentCallStats,
  getScopeContextHealthMetrics,
  listSettings,
  getSetting,
  setSetting,
  listWorkItemsWithCallRollups,
  getAgentCallsWithToolCountsByWorkItem,
  getAgentCallById,
  getToolInvocationsForAgentCall,
  getJob,
} from "../../../queue/functions/index.js";
import {
  getConfiguredImageModel,
  getConfiguredImageProviders,
} from "../../../artifacts/functions/index.js";
import { getConfiguredProviderUsage, inferProviderWindowLimit, providerRegistry } from "../../../providers/functions/provider.js";
import { getRuntimeDbPath, getRuntimeLogDir, getRuntimeReportsDir } from "../../../runtime/functions/paths.js";
import { jobReportStatus, workItemDisplayStatus } from "../display/Display.js";
import { getAccountSetting, getAccountSettingsPathForDisplay } from "../../../settings/functions/account-settings.js";
import { closePromptLog, promptPreviewText, readRecentPrompts } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeOutputLog, readRecentOutputs } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { closeLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { buildCurrentRoleContract } from "../../../worker/functions/role-contract-view.js";
import { getCatalogEntry, isAdminVisibleCatalogKey, isCatalogKey } from "../../../settings/functions/catalog.js";
import {
  loadSkillManifests,
  parseSkillIds,
  setSkillEnabled,
} from "../../../../shared/skills/functions/registry.js";
import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_SETTING_DEFS,
  PROVIDER_OPTIONS,
  getDefaultTierModel,
  getImageModelOptions,
  getProviderTierDefaults,
  getTextModelOptions,
} from "../../../providers/functions/model-catalog.js";
import { PROVIDER_ROLE_NAMES } from "../../../providers/functions/roles.js";
import { fit as fitAnsi, stripAnsi } from "../../../../shared/format/functions/ansi.js";
import {
  formatDuration as fmtDuration,
  formatRelativeTime as fmtRelativeTime,
  formatSignedTokens as fmtSignedTokens,
  formatTokens as fmtTokens,
  formatUsd as fmtUsd,
} from "../../../../shared/format/functions/units.js";
import {
  ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS,
  BOOLEAN_SETTING_KEYS,
  DEFAULT_ACCOUNT_SETTING_ROWS,
  DELEGATION_MODE_OPTIONS,
  ENUM_SETTING_OPTIONS,
  HIDDEN_SETTING_KEYS,
  MULTI_SETTING_KEYS,
  MULTI_SETTING_OPTIONS,
  MULTI_SETTING_VALUES,
  NUMERIC_SETTING_RULES,
  PROVIDER_SETTING_KEYS,
  PROJECT_DB_SETTING_KEYS,
  PROJECT_DB_TYPE_OPTIONS,
  PROJECT_DB_PERMISSION_OPTIONS,
  SETTINGS_GROUPS,
  SETTINGS_PANES,
  settingsPaneForKey,
  SKILL_SETTING_PREFIX,
  SYNTHETIC_SETTING_KEYS,
  toDisplaySettingKey,
  toStorageSettingKey,
} from "../../../settings/functions/admin-catalog.js";
import {
  readProjectDbConfig,
  writeProjectDbConfig,
  normalizePermissions as normalizeProjectDbPermissions,
  PROJECT_DB_TYPES,
} from "../../../../functions/toolkit/project-db/config.js";
import { installScipLanguageDependenciesSync } from "../../../atlas/functions/v2/scip/dependencies.js";
import { brandRule } from "../../functions/display/helpers/brand.js";
const PROVIDER_USAGE_SETTING_DEFS = [
  { provider: "claude", key: "claude_limit_tokens_session", label: "Claude session token limit", description: "Token cap for Claude's 5-hour rolling session window." },
  { provider: "claude", key: "claude_limit_tokens_week", label: "Claude weekly token limit", description: "Token cap for Claude's 7-day rolling weekly window." },
  { provider: "claude", key: "claude_observed_pct_session", label: "Claude session observed %", description: "Observed Claude session usage percent; saving this calibrates the 5-hour token cap." },
  { provider: "claude", key: "claude_observed_pct_week", label: "Claude weekly observed %", description: "Observed Claude weekly usage percent; saving this calibrates the 7-day token cap." },
];

const MODEL_SETTING_KEYS = new Set(MODEL_SETTING_DEFS.map((def) => def.key));
const PROVIDER_USAGE_SETTING_KEYS = new Set(PROVIDER_USAGE_SETTING_DEFS.map((def) => def.key));

function setSettingWithRuntimeSync(settingKey, value, projectDir = null) {
  setSetting(settingKey, value, { projectDir });
}

function getHistoryJobPresentation(job, jobs = []) {
  const rawStatus = job?.status || "unknown";
  const attemptCount = Number(job?.attempts || job?.attempt_count || 0) || 0;
  const displayStatus = jobReportStatus(job, jobs);

  if ((rawStatus === "queued" || rawStatus === "leased" || rawStatus === "running") && attemptCount > 1) {
    return {
      displayStatus: "retrying",
      icon: `${C.yellow}\u21bb`,
      label: `retrying after ${attemptCount - 1} failed attempt${attemptCount - 1 === 1 ? "" : "s"}`,
      attemptTag: `${attemptCount} attempts so far`,
    };
  }

  if (rawStatus === "succeeded" && attemptCount > 1) {
    return {
      displayStatus: "recovered",
      icon: `${C.yellow}\u21bb`,
      label: `recovered after retry`,
      attemptTag: `${attemptCount} attempts`,
    };
  }

  if (displayStatus === "recovered") {
    return {
      displayStatus,
      icon: `${C.yellow}\u21bb`,
      label: "recovered",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempts` : null,
    };
  }

  if (displayStatus === "succeeded") {
    return {
      displayStatus,
      icon: `${C.green}\u2713`,
      label: "succeeded",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (displayStatus === "failed" || displayStatus === "dead_letter") {
    return {
      displayStatus,
      icon: `${C.red}\u2717`,
      label: displayStatus,
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (rawStatus === "running") {
    return { displayStatus: rawStatus, icon: `${C.yellow}\u25b6`, label: "running", attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null };
  }

  return {
    displayStatus: rawStatus,
    icon: `${C.dim}\u00b7`,
    label: rawStatus,
    attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
  };
}

function canUseAdminTui({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return !!(
    stdin?.isTTY &&
    stdout?.isTTY &&
    typeof stdin?.setRawMode === "function"
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractAtlasTokenUsage(detailJson) {
  const detail = parseJsonObject(detailJson);
  const usage = detail?.token_usage || detail?.tokenUsage || null;
  if (!usage || typeof usage !== "object") return null;
  const atlasTokens = finiteNumber(usage.atlas_tokens ?? usage.atlasTokens);
  const rawEquivalent = finiteNumber(usage.raw_equivalent ?? usage.rawEquivalent);
  if (atlasTokens == null || rawEquivalent == null || rawEquivalent <= 0) return null;
  const savedTokens = finiteNumber(usage.saved_tokens ?? usage.savedTokens) ?? (rawEquivalent - atlasTokens);
  return {
    atlas_tokens: atlasTokens,
    raw_equivalent: rawEquivalent,
    saved_tokens: savedTokens,
  };
}

function foldAtlasTokenSavings(rows = []) {
  const byMethod = new Map();
  const ensure = (method) => {
    const key = String(method || "unknown");
    if (!byMethod.has(key)) {
      byMethod.set(key, {
        atlas_method: key,
        measured_calls: 0,
        raw_equivalent: 0,
        atlas_tokens: 0,
        saved_tokens: 0,
        negative_calls: 0,
      });
    }
    return byMethod.get(key);
  };
  for (const row of rows) {
    const usage = extractAtlasTokenUsage(row.detail_json);
    if (!usage) continue;
    const method = row.atlas_method || (String(row.observation_type || "") === "tool.atlas.prefetch" ? "prefetch" : "unknown");
    const bucket = ensure(method);
    bucket.measured_calls += 1;
    bucket.raw_equivalent += usage.raw_equivalent;
    bucket.atlas_tokens += usage.atlas_tokens;
    bucket.saved_tokens += usage.saved_tokens;
    if (usage.saved_tokens < 0) bucket.negative_calls += 1;
  }
  return [...byMethod.values()].sort((a, b) => {
    if (b.measured_calls !== a.measured_calls) return b.measured_calls - a.measured_calls;
    return String(a.atlas_method).localeCompare(String(b.atlas_method));
  });
}

function deriveAtlasReliabilityAction(detail = {}, row = {}) {
  const explicitAction = String(detail.action || "").trim();
  if (explicitAction) return explicitAction;

  const hasReliabilitySignal = Object.prototype.hasOwnProperty.call(detail, "ok")
    || Object.prototype.hasOwnProperty.call(detail, "status")
    || Object.prototype.hasOwnProperty.call(detail, "error")
    || Object.prototype.hasOwnProperty.call(detail, "empty")
    || Object.prototype.hasOwnProperty.call(detail, "duration_ms")
    || Object.prototype.hasOwnProperty.call(detail, "durationMs")
    || Object.prototype.hasOwnProperty.call(detail, "result_chars")
    || Object.prototype.hasOwnProperty.call(detail, "resultChars")
    || Object.prototype.hasOwnProperty.call(detail, "fallback");
  if (!hasReliabilitySignal) return null;

  const fallback = String(detail.fallback || "").trim();
  if (fallback) {
    const origin = String(
      detail.origin || (row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "agent")
    ).trim();
    return origin.toLowerCase() === "prefetch" ? "prefetch.fallback" : "fallback";
  }

  const summary = String(row.summary || "").trim();
  const summaryMatch = summary.match(/^ATLAS\s+([A-Za-z0-9_.:-]+)/i);
  if (summaryMatch?.[1]) return summaryMatch[1];

  return row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "unknown";
}

function extractAtlasToolReliability(row = {}) {
  const detail = parseJsonObject(row.detail_json);
  if (!detail || typeof detail !== "object") return null;
  if (detail.kind && String(detail.kind).toLowerCase() !== "atlas") return null;

  const action = deriveAtlasReliabilityAction(detail, row);
  if (!action) return null;
  const origin = String(
    detail.origin || (row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "agent")
  ).trim() || "agent";
  const status = String(detail.status || "").trim().toLowerCase();
  const errorText = String(detail.error || "").trim();
  const ok = detail.ok === true;
  const cancelled = status === "cancelled"
    || status === "canceled"
    || /user cancelled mcp tool call|cancelled|canceled/i.test(errorText);
  const failed = detail.ok === false || !!errorText || cancelled || status === "error" || status === "failed";
  const hasResultChars = Object.prototype.hasOwnProperty.call(detail, "result_chars")
    || Object.prototype.hasOwnProperty.call(detail, "resultChars");
  const resultChars = finiteNumber(detail.result_chars ?? detail.resultChars);
  const empty = detail.empty === true || (ok && hasResultChars && Number(resultChars || 0) === 0);

  return {
    action,
    origin,
    ok,
    failed,
    cancelled,
    empty,
    fallback: !!detail.fallback,
    duration_ms: finiteNumber(detail.duration_ms ?? detail.durationMs),
    result_chars: resultChars,
  };
}

function foldAtlasToolReliability(rows = []) {
  const byAction = new Map();
  const ensure = (action, origin) => {
    const key = `${origin}\u0000${action}`;
    if (!byAction.has(key)) {
      byAction.set(key, {
        action,
        origin,
        calls: 0,
        ok_calls: 0,
        failed_calls: 0,
        cancelled_calls: 0,
        empty_calls: 0,
        fallback_calls: 0,
        duration_calls: 0,
        total_duration_ms: 0,
        result_char_calls: 0,
        total_result_chars: 0,
      });
    }
    return byAction.get(key);
  };

  for (const row of rows) {
    const entry = extractAtlasToolReliability(row);
    if (!entry) continue;
    const bucket = ensure(entry.action, entry.origin);
    bucket.calls += 1;
    if (entry.ok) bucket.ok_calls += 1;
    if (entry.failed) bucket.failed_calls += 1;
    if (entry.cancelled) bucket.cancelled_calls += 1;
    if (entry.empty) bucket.empty_calls += 1;
    if (entry.fallback) bucket.fallback_calls += 1;
    if (entry.duration_ms != null) {
      bucket.duration_calls += 1;
      bucket.total_duration_ms += entry.duration_ms;
    }
    if (entry.result_chars != null) {
      bucket.result_char_calls += 1;
      bucket.total_result_chars += entry.result_chars;
    }
  }

  return [...byAction.values()].map((row) => ({
    ...row,
    avg_duration_ms: row.duration_calls > 0 ? Math.round(row.total_duration_ms / row.duration_calls) : null,
    avg_result_chars: row.result_char_calls > 0 ? Math.round(row.total_result_chars / row.result_char_calls) : null,
  })).sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls;
    if (b.failed_calls !== a.failed_calls) return b.failed_calls - a.failed_calls;
    const actionCmp = String(a.action).localeCompare(String(b.action));
    if (actionCmp !== 0) return actionCmp;
    return String(a.origin).localeCompare(String(b.origin));
  });
}

function normalizeAdminLine(str) {
  return String(str ?? "")
    .replace(/\u00c3\u00a2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u20ac\u201d/g, "\u2014");
}

// Key column width budget — clamped so very long catalog keys
// (e.g. context_expand_file_budget_per_attempt, 38 chars) still get
// flush-aligned columns without crushing the value/description areas.
const SETTINGS_KEY_COL_MIN = 28;
const SETTINGS_KEY_COL_MAX = 42;

function clampSettingsKeyColumnWidth(longestKeyLength) {
  const n = Number(longestKeyLength) || 0;
  return Math.max(SETTINGS_KEY_COL_MIN, Math.min(SETTINGS_KEY_COL_MAX, n));
}

function getSettingsValueColumnWidth(innerWidth, keyColumnWidth = SETTINGS_KEY_COL_MIN) {
  // Reserve: 2 leading spaces + 2 (#) + 1 + keyColumnWidth + 1 + 1 (desc gap)
  // ≈ keyColumnWidth + 7. Then cap the value column at 28 so descriptions
  // still get the lion's share of the row.
  const reserved = keyColumnWidth + 7;
  return Math.max(16, Math.min(28, innerWidth - reserved));
}

function getEffectiveModelSetting(def) {
  const stored = safeGetSetting(def.key);
  const providerDefaults = getModelProviderDefaults(def.provider);
  const baseModel = def.tier ? providerDefaults?.[def.tier]?.model : null;

  let effectiveModel = "";
  let source = "default";
  if (!def.tier && stored && String(stored).trim()) {
    effectiveModel = String(stored).trim();
    source = "global";
  } else if (def.tier && stored && String(stored).trim()) {
    effectiveModel = String(stored).trim();
    source = "global";
  } else if (!def.tier && def.provider === "claude") {
    effectiveModel = stored || `${C.dim}tier-driven${C.reset}`;
    source = stored ? "global" : "default";
  } else if (baseModel != null) {
    effectiveModel = baseModel || getDefaultTierModel(def.provider, def.tier) || "";
    source = "default";
  } else if (def.provider === "claude" && def.tier === "standard") {
    effectiveModel = getDefaultTierModel("claude", "standard") || "sonnet";
    source = "default";
  }

  return {
    storedValue: stored || "",
    effectiveModel: String(effectiveModel || "").trim() || (def.provider === "claude" && def.tier === "standard" ? (getDefaultTierModel("claude", "standard") || "sonnet") : ""),
    source,
  };
}

function getEffectiveImageModelSetting(def) {
  const stored = safeGetSetting(def.key);
  const choices = getImageModelOptions(def.provider, { currentValue: stored });
  const storedIsValid = choices.some((choice) => choice.value === stored);
  const effectiveModel = storedIsValid
    ? stored
    : (choices[0]?.value || "");
  return {
    storedValue: storedIsValid ? (stored || "") : "",
    effectiveModel,
    source: storedIsValid ? "global" : "default",
  };
}

function getModelChoicesForEntry(entry) {
  if (!entry) return [{ value: "", label: "(default: tier model)" }];
  const currentValue = safeGetSetting(entry.key);
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

function isAdminProviderOption(providerName) {
  const provider = String(providerName || "").trim().toLowerCase();
  if (!provider || !providerRegistry.has(provider)) return false;
  const mod = providerRegistry.get(provider);
  if (typeof mod?.hasCredentials === "function") {
    try { return !!mod.hasCredentials(); } catch { return false; }
  }
  // Claude has no cheap credential probe; avoid CLI readiness checks while
  // rendering settings and let the boot provider panel report readiness.
  return true;
}

function getSelectableImageProviders() {
  return IMAGE_PROVIDER_OPTIONS.filter((option) => isAdminProviderOption(option.value));
}

function getProviderUsageStoredValue(settingKey) {
  const globalValue = getAccountSetting(settingKey);
  if (globalValue != null && String(globalValue).trim() !== "") return String(globalValue);
  return safeGetSetting(settingKey);
}

function setProviderUsageStoredValue(settingKey, value) {
  setSettingWithRuntimeSync(settingKey, value);
}

export function validateAdminSettingValue(settingKey, value) {
  const storageKey = toStorageSettingKey(String(settingKey || "").trim());
  if (!storageKey) return { ok: false, error: "Setting key is required." };
  const rawValue = String(value ?? "");
  const trimmed = rawValue.trim();

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
    const selectable = new Set(PROVIDER_OPTIONS.filter((provider) => isAdminProviderOption(provider)));
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
    const allowed = getModelChoicesForEntry(def).map((choice) => choice.value);
    if (trimmed !== "" && !allowed.includes(trimmed)) {
      return { ok: false, error: `${settingKey} must be a configured model choice or empty for default.` };
    }
    return { ok: true, storageKey, value: trimmed };
  }

  const normalized = normalizeNumericSettingValue(storageKey, rawValue);
  if (!normalized.ok) return normalized;
  return { ok: true, storageKey, value: normalized.value };
}

function safeGetSetting(key, projectDir = null) {
  if (runtimeDbLooksBusyOrCorrupt()) return null;
  try {
    return getSetting(key, { projectDir });
  } catch {
    return null;
  }
}

function safeListSettings(projectDir = null) {
  if (runtimeDbLooksBusyOrCorrupt()) return [];
  try {
    return listSettings({ projectDir });
  } catch {
    return [];
  }
}

// ─── Report File Reader ─────────────────────────────────────────────────────

// ─── Admin TUI ──────────────────────────────────────────────────────────────


export class AdminSettingsController {
  _cycleImageModel() {
    const imagePresets = IMAGE_PROVIDER_OPTIONS.flatMap((providerOption) =>
      getImageModelOptions(providerOption.value).map((modelOption) => ({
        provider: providerOption.value,
        model: modelOption.value,
      }))
    );
    if (imagePresets.length === 0) return;
    try {
      const currentProvider = getConfiguredImageProviders()[0] || imagePresets[0].provider;
      const currentModel = getConfiguredImageModel(currentProvider) || imagePresets[0].model;
      const idx = imagePresets.findIndex((preset) => preset.provider === currentProvider && preset.model === currentModel);
      const next = imagePresets[(idx + 1 + imagePresets.length) % imagePresets.length];
      setSettingWithRuntimeSync("artifact_image_provider", next.provider, this.projectDir);
      setSettingWithRuntimeSync(`${next.provider}_image_model`, next.model, this.projectDir);
      this._invalidateSettingsCache();
    } catch { /* config not found */ }
    this.requestRender({ force: true });
  }

  _invalidateSettingsCache() {
    this._settingsCache = null;
    this._settingsCacheAt = 0;
  }

  _getArtifactSettingEntries() {
    const savedProvider = safeGetSetting("artifact_image_provider");
    const configuredProviders = getConfiguredImageProviders();
    const selectableProviders = getSelectableImageProviders();
    const providerValue = configuredProviders.join(",") || (selectableProviders[0]?.value || "openai");
    return [
      {
        setting_key: "artifact_image_provider",
        setting_value: providerValue,
        updated_at: null,
        description: `Provider for image artifacts; selectable: ${selectableProviders.map((option) => option.value).join(", ") || "none"}`,
        label: "image artifact provider",
        source: savedProvider ? "global" : "config",
        provider: providerValue,
      },
    ];
  }

  _getSkillSettingEntries() {
    let manifests = [];
    try {
      manifests = loadSkillManifests();
    } catch {
      manifests = [];
    }
    const disabled = new Set(parseSkillIds(safeGetSetting(SETTING_KEYS.SKILLS_DISABLED_IDS) || ""));
    return manifests.map((skill) => ({
      setting_key: `skill:${skill.id}`,
      storage_key: `${SKILL_SETTING_PREFIX}${skill.id}`,
      setting_value: disabled.has(skill.id) ? "false" : "true",
      updated_at: null,
      description: `${skill.name}: ${skill.when_to_use || skill.description || "planner-selectable skill"}`,
      label: skill.name,
      source: "skills",
      skill_id: skill.id,
    }));
  }

  _getProjectDbSettingEntries() {
    let cfg;
    try {
      cfg = readProjectDbConfig({ projectDir: this.projectDir });
    } catch {
      cfg = { enabled: false, dbType: null, host: null, port: null, database: null, username: null, hasPassword: false, permissions: [] };
    }
    const row = (key, value, description) => ({
      setting_key: key,
      storage_key: key,
      setting_value: value,
      updated_at: null,
      description,
      source: "project_db",
      projectDb: true,
    });
    return [
      row("project_db_enabled", cfg.enabled ? "true" : "false", "Enable the opt-in project_db_query agent tool for this repo."),
      row("project_db_type", cfg.dbType || "", "Project database engine: sqlite, postgres, or mysql."),
      row("project_db_permissions", (cfg.permissions || []).join(","), "Granted SQL ops: read, write, insert, delete (DDL never allowed)."),
      row("project_db_database", cfg.database || "", "sqlite: file path (relative to repo). postgres/mysql: database name."),
      row("project_db_host", cfg.host || "", "postgres/mysql host (ignored for sqlite)."),
      row("project_db_port", cfg.port != null ? String(cfg.port) : "", "postgres/mysql port (ignored for sqlite)."),
      row("project_db_username", cfg.username || "", "postgres/mysql username (ignored for sqlite)."),
      row("project_db_password", cfg.hasPassword ? "********" : "", "postgres/mysql password — stored in .posse/db; never displayed. Blank = unchanged."),
    ];
  }

  _getSettingsSnapshot({ maxAgeMs = 2000 } = {}) {
    const now = Date.now();
    if (this._settingsCache && now - this._settingsCacheAt <= maxAgeMs) {
      return this._settingsCache;
    }
    const storedSettings = safeListSettings(this.projectDir);
    const mergedSettings = [...storedSettings];
    const seenSettingKeys = new Set(storedSettings.map((entry) => entry.setting_key));
    for (const fallback of DEFAULT_ACCOUNT_SETTING_ROWS) {
      if (seenSettingKeys.has(fallback.setting_key)) continue;
      mergedSettings.push({
        setting_key: fallback.setting_key,
        setting_value: fallback.setting_value,
        updated_at: null,
        source: "default",
      });
    }
    const dbSettings = mergedSettings.filter((entry) =>
      isAdminVisibleCatalogKey(toStorageSettingKey(entry.setting_key)) &&
      !HIDDEN_SETTING_KEYS.has(entry.setting_key) &&
      !MODEL_SETTING_KEYS.has(entry.setting_key) &&
      !PROVIDER_USAGE_SETTING_KEYS.has(entry.setting_key) &&
      !PROVIDER_SETTING_KEYS.has(entry.setting_key) &&
      !ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(entry.setting_key) &&
      !SYNTHETIC_SETTING_KEYS.has(entry.setting_key)
    ).map((entry) => toDisplaySettingEntry(entry));

    // Sort dbSettings to match the visual order in SETTINGS_GROUPS so that
    // ↑/↓ navigation walks through the same sequence the user sees, and so
    // section-jump nav lands on contiguous index ranges. Ungrouped keys sort
    // to the end (they render in a Misc section).
    const groupOrder = new Map();
    let groupOrderCounter = 0;
    for (const group of SETTINGS_GROUPS) {
      for (const key of group.keys) groupOrder.set(key, groupOrderCounter++);
    }
    dbSettings.sort((a, b) => {
      const oa = groupOrder.has(a.setting_key) ? groupOrder.get(a.setting_key) : Number.MAX_SAFE_INTEGER;
      const ob = groupOrder.has(b.setting_key) ? groupOrder.get(b.setting_key) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return String(a.setting_key).localeCompare(String(b.setting_key));
    });
    const dbSettingsByPane = { providers: [], atlas: [], general: [], debug: [] };
    for (const entry of dbSettings) {
      const pane = settingsPaneForKey(entry.setting_key);
      (dbSettingsByPane[pane] || dbSettingsByPane.general).push(entry);
    }
    const modelSettings = this._getModelSettingEntries();
    const artifactSettings = this._getArtifactSettingEntries();
    const providerUsageSettings = this._getProviderUsageSettingEntries();
    const providerSettings = this._getProviderSettingEntries();
    const delegationSettings = this._getDelegationSettingEntries();
    const skillSettings = this._getSkillSettingEntries();
    const projectDbSettings = this._getProjectDbSettingEntries();
    // Per-pane editable lists. Order here MUST match the visual row order
    // _buildSettings renders for that pane — ↑/↓ selection walks this list.
    const paneEditableSettings = {
      providers: [
        ...providerSettings,
        ...delegationSettings,
        ...artifactSettings,
        ...providerUsageSettings,
        ...modelSettings,
        ...dbSettingsByPane.providers,
      ],
      atlas: [
        ...dbSettingsByPane.atlas,
      ],
      general: [
        ...dbSettingsByPane.general,
        ...skillSettings,
        ...projectDbSettings,
      ],
      debug: [
        ...dbSettingsByPane.debug,
      ],
    };
    const editableSettings = [
      ...paneEditableSettings.providers,
      ...paneEditableSettings.atlas,
      ...paneEditableSettings.general,
      ...paneEditableSettings.debug,
    ];
    this._settingsCache = {
      dbSettings,
      dbSettingsByPane,
      modelSettings,
      artifactSettings,
      providerUsageSettings,
      providerSettings,
      delegationSettings,
      skillSettings,
      projectDbSettings,
      editableSettings,
      paneEditableSettings,
    };
    this._settingsCacheAt = now;
    return this._settingsCache;
  }

  _getModelSettingEntries() {
    const selectableProviders = new Set(this._getSelectableProviders());
    return MODEL_SETTING_DEFS
      .filter((def) => selectableProviders.has(def.provider))
      .map((def) => {
        const resolved = def.kind === "image"
          ? getEffectiveImageModelSetting(def)
          : getEffectiveModelSetting(def);
        return {
          setting_key: def.key,
          setting_value: resolved.storedValue,
          updated_at: null,
          description: def.description,
          label: def.label,
          provider: def.provider,
          source: resolved.source,
          effective_model: resolved.effectiveModel,
          tier: def.tier,
          kind: def.kind || "text",
        };
      });
  }

  _getProviderUsageSettingEntries() {
    return [];
  }

  _getSelectableProviders() {
    return PROVIDER_OPTIONS.filter((provider) => isAdminProviderOption(provider));
  }

  _normalizeProviderList(value) {
    const allowed = new Set(this._getSelectableProviders());
    const picked = String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((provider, index, arr) => arr.indexOf(provider) === index)
      .filter((provider) => allowed.has(provider));
    return picked.length > 0 ? picked.join(",") : "claude";
  }

  _getProviderSettingEntries() {
    const selectable = this._getSelectableProviders();
    return PROVIDER_ROLE_NAMES.map((role) => {
      const storedVal = safeGetSetting(`provider_${role}`);
      const effective = storedVal || "claude";
      const source = storedVal ? "global" : "default";
      return {
        setting_key: `provider_${role}`,
        setting_value: effective,
        updated_at: null,
        description: `Comma-separated providers for ${role}; selectable: ${selectable.join(", ")}`,
        label: `${role} providers`,
        source,
        db_value: storedVal || "",
        role,
      };
    });
  }

  _getDelegationSettingEntries() {
    const storedVal = safeGetSetting("delegation_mode");
    return [{
      setting_key: "delegation_mode",
      setting_value: storedVal || "js",
      updated_at: null,
      description: `Delegation engine mode; options: ${DELEGATION_MODE_OPTIONS.join(", ")}`,
      label: "delegation mode",
      source: storedVal ? "global" : "default",
      db_value: storedVal || "",
    }];
  }

  _getEditableSettings() {
    const snapshot = this._getSettingsSnapshot();
    const paneList = snapshot.paneEditableSettings?.[this._settingsPane];
    return paneList || snapshot.editableSettings;
  }

  _cycleSettingsPane(direction) {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const currentIndex = paneIds.indexOf(this._settingsPane);
    const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + direction + paneIds.length) % paneIds.length;
    this._settingsPane = paneIds[nextIndex];
    this._settingsIndex = 0;
    this._scroll = 0;
    this._tabScrolls[this._tab] = 0;
  }

  _getSelectedEditableSetting() {
    const settings = this._getEditableSettings();
    if (settings.length === 0) return null;
    const idx = Math.max(0, Math.min(this._settingsIndex, settings.length - 1));
    this._settingsIndex = idx;
    return settings[idx];
  }

  _moveSettingsSelection(delta) {
    const settings = this._getEditableSettings();
    if (settings.length === 0) return;
    this._settingsIndex = Math.max(0, Math.min(this._settingsIndex + delta, settings.length - 1));
    const selected = settings[this._settingsIndex];
    const row = this._settingsRowMap.get(selected?.setting_key);
    if (typeof row === "number") {
      const visibleRows = Math.max(this.rows - 6, 5);
      if (row < this._scroll) this._scroll = row;
      else if (row >= this._scroll + visibleRows) this._scroll = Math.max(0, row - visibleRows + 1);
      this._tabScrolls[this._tab] = this._scroll;
    }
  }

  /**
   * Jump the settings selection to the start of the next (direction > 0) or
   * previous (direction < 0) section. Sections are the row indices recorded
   * during _buildSettings into this._settingsSectionRows.
   */
  _jumpSettingsSection(direction) {
    const sectionRows = Array.isArray(this._settingsSectionRows) ? this._settingsSectionRows : [];
    if (sectionRows.length === 0) return;
    const settings = this._getEditableSettings();
    if (settings.length === 0) return;
    const current = settings[this._settingsIndex];
    const currentRow = current ? this._settingsRowMap.get(current.setting_key) : null;
    const referenceRow = typeof currentRow === "number" ? currentRow : -1;
    let targetSectionRow;
    if (direction > 0) {
      targetSectionRow = sectionRows.find((r) => r > referenceRow);
    } else {
      targetSectionRow = [...sectionRows].reverse().find((r) => r < referenceRow);
    }
    if (targetSectionRow == null) return;
    // Find the first editable setting whose row is greater than the section header.
    let bestIdx = -1;
    let bestRow = Infinity;
    for (let i = 0; i < settings.length; i++) {
      const row = this._settingsRowMap.get(settings[i].setting_key);
      if (typeof row !== "number") continue;
      if (row > targetSectionRow && row < bestRow) {
        bestRow = row;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;
    this._settingsIndex = bestIdx;
    // Scroll so the section header itself stays in view as context.
    this._scroll = Math.max(0, targetSectionRow - 1);
    this._tabScrolls[this._tab] = this._scroll;
  }

  _startEdit(initialValue = null) {
    const selected = this._getSelectedEditableSetting();
    if (!selected) return;
    this._editError = "";
    const storageKey = selected.storage_key || toStorageSettingKey(selected.setting_key);
    if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
      this._startProjectDbEdit(selected, storageKey, initialValue);
      return;
    }
    if (storageKey.startsWith("provider_") || ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(storageKey)) {
      const allowed = storageKey.startsWith("provider_")
        ? this._getSelectableProviders()
        : getSelectableImageProviders().map((option) => option.value);
      const enabled = new Set(parseProviderList(selected.setting_value));
      this._editing = "editProviders";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editProviderChoices = allowed.map((provider) => ({
        provider,
        enabled: enabled.has(provider),
      }));
      this._editProviderIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (MODEL_SETTING_KEYS.has(storageKey)) {
      const choices = getModelChoicesForEntry(selected);
      const currentValue = selected.setting_value || "";
      this._editing = "editModel";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editModelChoices = choices;
      const requestedValue = initialValue == null ? currentValue : String(initialValue);
      const pickedIndex = choices.findIndex((choice) => choice.value === requestedValue);
      this._editModelIndex = pickedIndex >= 0 ? pickedIndex : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (storageKey === SETTING_KEYS.SKILLS_DISABLED_IDS) {
      let manifests = [];
      try { manifests = loadSkillManifests(); } catch { manifests = []; }
      const currentRaw = initialValue == null ? (selected.setting_value || "") : String(initialValue);
      const disabled = new Set(parseSkillIds(currentRaw));
      this._editing = "editSkills";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editSkillChoices = manifests.map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        disabled: disabled.has(skill.id),
      }));
      this._editSkillIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (MULTI_SETTING_KEYS.has(storageKey)) {
      const allowed = MULTI_SETTING_VALUES[storageKey] || new Set();
      const options = MULTI_SETTING_OPTIONS[storageKey] || [];
      const currentValue = initialValue == null ? (selected.setting_value || "") : String(initialValue);
      const enabled = new Set(
        currentValue
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => allowed.has(entry))
      );
      this._editing = "editPhases";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editPhaseChoices = options.map((option) => ({
        value: option.value,
        label: option.label,
        enabled: enabled.has(option.value),
      }));
      this._editPhaseIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    const enumChoices = ENUM_SETTING_OPTIONS[storageKey];
    if (enumChoices && enumChoices.length > 0) {
      const currentValue = String(selected.setting_value || "").trim().toLowerCase();
      this._editing = "editModel";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editModelChoices = enumChoices.map((choice) => ({ value: choice.value, label: choice.label }));
      const requestedValue = initialValue == null ? currentValue : String(initialValue).trim().toLowerCase();
      const pickedIndex = this._editModelChoices.findIndex((choice) => choice.value === requestedValue);
      this._editModelIndex = pickedIndex >= 0 ? pickedIndex : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    const currentValue = selected.setting_value || "";
    if (BOOLEAN_SETTING_KEYS.has(storageKey) || isBooleanSettingValue(currentValue)) {
      this._editing = "editBoolean";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editBooleanChoices = ["true", "false"];
      const requestedValue = initialValue == null ? currentValue : String(initialValue).toLowerCase();
      const pickedIndex = this._editBooleanChoices.indexOf(requestedValue);
      this._editBooleanIndex = pickedIndex >= 0 ? pickedIndex : (currentValue === "true" ? 0 : 1);
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    this._editing = "editValue";
    this._editKey = selected.setting_key;
    this._editStorageKey = storageKey;
    this._editBuf = initialValue == null ? currentValue : initialValue;
    this._editCursor = this._editBuf.length;
    process.stdout.write("\x1b[?25h"); // show cursor
    this.requestRender({ force: true });
  }

  _startProjectDbEdit(selected, storageKey, initialValue = null) {
    const currentValue = selected.setting_value || "";
    this._editKey = selected.setting_key;
    this._editStorageKey = storageKey;
    if (storageKey === "project_db_enabled") {
      this._editing = "editBoolean";
      this._editBooleanChoices = ["true", "false"];
      this._editBooleanIndex = currentValue === "true" ? 0 : 1;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (storageKey === "project_db_type") {
      this._editing = "editModel";
      this._editModelChoices = PROJECT_DB_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
      const idx = this._editModelChoices.findIndex((c) => c.value === currentValue);
      this._editModelIndex = idx >= 0 ? idx : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (storageKey === "project_db_permissions") {
      const enabled = new Set(currentValue.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
      this._editing = "editPhases";
      this._editPhaseChoices = PROJECT_DB_PERMISSION_OPTIONS.map((o) => ({ value: o.value, label: o.label, enabled: enabled.has(o.value) }));
      this._editPhaseIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    // Free-text fields. The password starts empty (so a blank save means
    // "leave unchanged") and is masked while typing.
    this._editing = "editValue";
    this._editBuf = storageKey === "project_db_password"
      ? ""
      : (initialValue == null ? currentValue : String(initialValue));
    this._editCursor = this._editBuf.length;
    process.stdout.write("\x1b[?25h");
    this.requestRender({ force: true });
  }

  _saveProjectDbSetting(storageKey, value) {
    const patch = {};
    switch (storageKey) {
      case "project_db_enabled": patch.enabled = String(value).toLowerCase() === "true"; break;
      case "project_db_type": patch.dbType = value || null; break;
      case "project_db_permissions": patch.permissions = value; break;
      case "project_db_database": patch.database = value || null; break;
      case "project_db_host": patch.host = value || null; break;
      case "project_db_port": patch.port = value === "" ? null : Number(value); break;
      case "project_db_username": patch.username = value || null; break;
      case "project_db_password":
        if (String(value) === "") return; // blank = leave the stored password unchanged
        patch.password = value;
        break;
      default: throw new Error(`Unknown project DB setting: ${storageKey}`);
    }
    writeProjectDbConfig(patch, { projectDir: this.projectDir });
  }

  _resetEditState() {
    const hadEditing = !!this._editing;
    this._editing = false;
    this._editBuf = "";
    this._editKey = "";
    this._editStorageKey = "";
    this._editProviderChoices = [];
    this._editProviderIndex = 0;
    this._editPhaseChoices = [];
    this._editPhaseIndex = 0;
    this._editSkillChoices = [];
    this._editSkillIndex = 0;
    this._editModelChoices = [];
    this._editModelIndex = 0;
    this._editBooleanChoices = [];
    this._editBooleanIndex = 0;
    this._editError = "";
    if (hadEditing) process.stdout.write("\x1b[?25l");
  }

  _saveSettingValue(storageKey, value, { providerUsage = false } = {}) {
    try {
      if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
        this._saveProjectDbSetting(storageKey, value);
        this._settingsSavedFlash = { text: `Saved ${storageKey}`, at: Date.now() };
        return true;
      }
      if (storageKey.startsWith(SKILL_SETTING_PREFIX)) {
        setSkillEnabled(storageKey.slice(SKILL_SETTING_PREFIX.length), String(value).trim().toLowerCase() === "true");
      } else if (providerUsage) {
        setProviderUsageStoredValue(storageKey, value);
      } else {
        setSettingWithRuntimeSync(storageKey, value, this.projectDir);
        if (storageKey === SETTING_KEYS.ATLAS_SCIP_LANGUAGES) {
          this._installScipLanguageDependencies(value);
        }
      }
      // Transient nav-bar confirmation: saves are otherwise only visible as
      // the value changing in the list, which is easy to miss.
      this._settingsSavedFlash = {
        text: `Saved ${toDisplaySettingKey(storageKey)}`,
        at: Date.now(),
      };
      return true;
    } catch (err) {
      this._editError = `Save failed: ${err?.message || err}`;
      this.requestRender({ force: true });
      return false;
    }
  }

  _installScipLanguageDependencies(value) {
    if (typeof this._runScipLanguageDependencyInstallAsync === "function") {
      this._runScipLanguageDependencyInstallAsync(value);
      return;
    }
    console.log(`SCIP deps: checking ${String(value || "").trim() || "configured languages"}`);
    const result = installScipLanguageDependenciesSync({
      languages: value,
      onProgress: (message) => console.log(`SCIP deps: ${message}`),
    });
    for (const entry of result.results) {
      const prefix = entry.ok ? "ok" : "warn";
      console.log(`SCIP deps ${prefix}: ${entry.language}: ${entry.message}`);
    }
    if (!result.ok) {
      console.error("SCIP deps: selected languages were saved, but one or more installers did not complete; see the language messages above");
    }
  }

  _onEditKeypress(str, key) {
    if (key && key.name === "escape") {
      this._resetEditState();
      this.requestRender({ force: true });
      return;
    }

    if (this._editing === "editProviders") {
      const maxIndex = Math.max(this._editProviderChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const picked = this._editProviderChoices
          .filter((choice) => choice.enabled)
          .map((choice) => choice.provider);
        const isImageRoute = ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(this._editStorageKey || toStorageSettingKey(this._editKey));
        const fallback = isImageRoute
          ? (this._editProviderChoices[0]?.provider || "openai")
          : (this._editProviderChoices.some((choice) => choice.provider === "claude") ? "claude" : this._editProviderChoices[0]?.provider || "claude");
        const savedValue = picked.length > 0 ? picked.join(",") : fallback;
        if (!this._saveSettingValue(this._editStorageKey || toStorageSettingKey(this._editKey), savedValue)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editProviderIndex = Math.max(0, this._editProviderIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editProviderIndex = Math.min(maxIndex, this._editProviderIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editProviderIndex = idx;
        } else if (printable) {
          const hotkeyIndex = this._editProviderChoices.findIndex((choice) => choice.provider[0] === printable);
          if (hotkeyIndex >= 0) this._editProviderIndex = hotkeyIndex;
        }
        if (key?.name === "space" || printable === " ") {
          const choice = this._editProviderChoices[this._editProviderIndex];
          if (choice) choice.enabled = !choice.enabled;
        } else if (["c", "o", "g", "x"].includes(printable)) {
          const aliases = { c: "claude", o: "openai", g: "grok", x: "codex" };
          const target = aliases[printable];
          const choice = this._editProviderChoices.find((entry) => entry.provider === target);
          if (choice) choice.enabled = !choice.enabled;
        }
      }
    } else if (this._editing === "editSkills") {
      const maxIndex = Math.max(this._editSkillChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const disabledIds = this._editSkillChoices
          .filter((choice) => choice.disabled)
          .map((choice) => choice.id);
        const savedValue = [...disabledIds].sort().join(",");
        if (!this._saveSettingValue(this._editStorageKey || SETTING_KEYS.SKILLS_DISABLED_IDS, savedValue)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editSkillIndex = Math.max(0, this._editSkillIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editSkillIndex = Math.min(maxIndex, this._editSkillIndex + 1);
      } else if (key?.name === "pageup") {
        this._editSkillIndex = Math.max(0, this._editSkillIndex - 8);
      } else if (key?.name === "pagedown") {
        this._editSkillIndex = Math.min(maxIndex, this._editSkillIndex + 8);
      } else if (key?.name === "home") {
        this._editSkillIndex = 0;
      } else if (key?.name === "end") {
        this._editSkillIndex = maxIndex;
      } else {
        const printable = getPrintableInput(str, key);
        if (key?.name === "space" || printable === " ") {
          const choice = this._editSkillChoices[this._editSkillIndex];
          if (choice) choice.disabled = !choice.disabled;
        } else if (printable && /^[1-9]$/.test(printable)) {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editSkillIndex = idx;
        }
      }
    } else if (this._editing === "editPhases") {
      const maxIndex = Math.max(this._editPhaseChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const picked = this._editPhaseChoices
          .filter((choice) => choice.enabled)
          .map((choice) => choice.value);
        const savedValue = picked.join(",");
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        const validated = validateAdminSettingValue(storageKey, savedValue);
        if (!validated.ok) {
          this._editError = validated.error;
          this.requestRender({ force: true });
          return;
        }
        if (!this._saveSettingValue(storageKey, validated.value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editPhaseIndex = Math.max(0, this._editPhaseIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editPhaseIndex = Math.min(maxIndex, this._editPhaseIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editPhaseIndex = idx;
        }
        if (key?.name === "space" || printable === " ") {
          const choice = this._editPhaseChoices[this._editPhaseIndex];
          if (choice) choice.enabled = !choice.enabled;
        }
      }
    } else if (this._editing === "editModel") {
      const maxIndex = Math.max(this._editModelChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const value = this._editModelChoices[this._editModelIndex]?.value || "";
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        if (!this._saveSettingValue(storageKey, value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editModelIndex = Math.max(0, this._editModelIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editModelIndex = Math.min(maxIndex, this._editModelIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editModelIndex = idx;
        }
      }
    } else if (this._editing === "editBoolean") {
      const maxIndex = Math.max(this._editBooleanChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const value = this._editBooleanChoices[this._editBooleanIndex] || "false";
        if (!this._saveSettingValue(this._editStorageKey || toStorageSettingKey(this._editKey), value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editBooleanIndex = Math.max(0, this._editBooleanIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editBooleanIndex = Math.min(maxIndex, this._editBooleanIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable === " " || printable === "t") {
          this._editBooleanIndex = 0;
        } else if (printable === "f") {
          this._editBooleanIndex = 1;
        }
      }
    } else if (this._editing === "editValue") {
      if (isEnterKey(str, key)) {
        const rawValue = this._editKey.startsWith("provider_")
          ? this._normalizeProviderList(this._editBuf)
          : this._editBuf;
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        const validated = validateAdminSettingValue(storageKey, rawValue);
        if (!validated.ok) {
          this._editError = validated.error;
          this.requestRender({ force: true });
          return;
        }
        const value = validated.value;
        if (PROVIDER_USAGE_SETTING_KEYS.has(storageKey)) {
          if (!this._saveSettingValue(storageKey, value, { providerUsage: true })) return;
        } else if (!this._saveSettingValue(storageKey, value)) {
          return;
        }
        const parsedUsageKey = parseProviderUsageSettingKey(storageKey);
        if (parsedUsageKey?.kind === "observed_pct") {
          const calibration = inferProviderWindowLimit(parsedUsageKey.provider, parsedUsageKey.windowKey, value);
          const limitKey = correspondingLimitSettingKey(storageKey);
          if (limitKey && calibration?.limitTokens != null) {
            if (!this._saveSettingValue(limitKey, String(calibration.limitTokens), { providerUsage: true })) return;
          }
        }
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (isBackspaceKey(str, key)) {
        this._editError = "";
        this._editBuf = this._editBuf.slice(0, -1);
      } else if (!key?.ctrl) {
        const printable = getPrintableInput(str, key);
        if (printable) {
          this._editError = "";
          this._editBuf += printable;
        }
      }
    }

    this.requestRender({ force: true });
  }

  _buildEditValueNavLines(fullW) {
    const instructions = `${C.dim}[Enter] Save  [Esc] Cancel${C.reset}`;
    const prefixText = ` Editing ${this._editKey}: `;
    const available = Math.max(8, fullW - stripAnsi(prefixText).length - stripAnsi(instructions).length - 2);
    const editBuf = this._editStorageKey === "project_db_password"
      ? "*".repeat(this._editBuf.length)
      : this._editBuf;
    const visibleValue = clipPlainTail(editBuf, available);
    const clipped = visibleValue.startsWith("\u2026");
    const lines = [
      ` ${C.yellow}Editing ${this._editKey}:${C.reset} ${C.bold}${visibleValue}${C.reset}  ${instructions}`,
    ];
    if (clipped) {
      lines.push(` ${C.dim}Input clipped on the left so your latest typing stays visible.${C.reset}`);
    }
    if (this._editError) {
      lines.push(` ${C.red}${this._editError}${C.reset}`);
    }
    return lines;
  }

  _getEditValueCursorPosition(fullW, navStartRow) {
    const instructions = `${C.dim}[Enter] Save  [Esc] Cancel${C.reset}`;
    const prefixText = ` Editing ${this._editKey}: `;
    const available = Math.max(8, fullW - stripAnsi(prefixText).length - stripAnsi(instructions).length - 2);
    const editBuf = this._editStorageKey === "project_db_password"
      ? "*".repeat(this._editBuf.length)
      : this._editBuf;
    const visibleValue = clipPlainTail(editBuf, available);
    const cursorCol = 2 + visibleLength(prefixText) + visibleLength(visibleValue);
    return { row: navStartRow, col: cursorCol };
  }

  _buildEditBooleanNavLines() {
    const toggles = this._editBooleanChoices.map((choice, index) => {
      const selected = index === this._editBooleanIndex;
      const marker = selected ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
      const label = selected ? `${C.yellow}>${choice}<${C.reset}` : choice;
      return `${marker} ${label}`;
    }).join(` ${C.dim}|${C.reset} `);
    return [
      ` ${C.yellow}Editing ${this._editKey}:${C.reset} ${toggles}`,
      ` ${C.dim}[←→/↑↓] Choose  [t/f] Jump  [Enter] Save  [Esc] Cancel${C.reset}`,
    ];
  }

  _buildEditModelNavLines() {
    const lines = [` ${C.yellow}Editing ${this._editKey}:${C.reset}`];
    for (let index = 0; index < this._editModelChoices.length; index++) {
      const choice = this._editModelChoices[index];
      const selected = index === this._editModelIndex;
      const marker = selected ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
      const label = selected ? `${C.yellow}${choice.label}${C.reset}` : choice.label;
      const prefix = selected ? `${C.yellow}>${C.reset}` : " ";
      lines.push(` ${prefix} ${marker} ${index + 1}:${label}`);
    }
    lines.push(` ${C.dim}[←→/↑↓] Choose  [1-9] Jump  [Enter] Save  [Esc] Cancel${C.reset}`);
    return lines;
  }

  _buildSettings(width) {
    const lines = [];
    const inner = width - 2;
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const settingsPane = paneIds.includes(this._settingsPane) ? this._settingsPane : "all";
    this._settingsRowMap = new Map();
    // List of row indices that hold a section header \u2014 used by PgUp/PgDn
    // jump nav to step between groups.
    this._settingsSectionRows = [];
    const ruleWidth = Math.max(40, Math.min(inner, 76));

    lines.push("");
    lines.push(brandRule({ label: "settings", color: C.cyan, width: ruleWidth }));
    if (settingsPane !== "all") {
      const paneBar = SETTINGS_PANES.map((pane) => (
        pane.id === settingsPane
          ? `${C.bold}${C.cyan}[${pane.label}]${C.reset}`
          : `${C.dim}${pane.label}${C.reset}`
      )).join(` ${C.dim}|${C.reset} `);
      lines.push(` ${paneBar}  ${C.dim}press \u2190/\u2192 to switch${C.reset}`);
    }
    lines.push("");

    const settingsSnapshot = this._getSettingsSnapshot();
    const dbSettingsByPane = settingsSnapshot.dbSettingsByPane
      || { providers: [], atlas: [], general: [], debug: [] };
    const providerSettings = settingsSnapshot.providerSettings;
    const modelSettings = settingsSnapshot.modelSettings;
    const artifactSettings = settingsSnapshot.artifactSettings || [];
    const providerUsageSettings = settingsSnapshot.providerUsageSettings || [];
    const delegationSettings = settingsSnapshot.delegationSettings || [];
    const skillSettings = settingsSnapshot.skillSettings || [];
    const projectDbSettings = settingsSnapshot.projectDbSettings || [];
    const providerUsageWindowMap = providerUsageSettings.length > 0
      ? buildProviderUsageWindowMap(getConfiguredProviderUsage())
      : new Map();
    const delegationMode = delegationSettings[0]?.setting_value || "js";
    const editableSettings = this._getEditableSettings();
    if (editableSettings.length > 0) {
      this._settingsIndex = Math.max(0, Math.min(this._settingsIndex, editableSettings.length - 1));
    }
    const selectedSetting = editableSettings[this._settingsIndex] || null;
    const selectedKey = this._editing ? this._editKey : selectedSetting?.setting_key;
    const isHighlightedSetting = (settingKey) => selectedKey === settingKey;
    // Compute the key column width from the longest setting key across every
    // pane (not just the active one) so columns stay flush when switching
    // panes. Clamp into a sane range so descriptions still get most of the
    // row width.
    const longestKeyLen = (settingsSnapshot.editableSettings || []).reduce(
      (max, s) => Math.max(max, String(s.setting_key || "").length),
      0,
    );
    const keyWidth = clampSettingsKeyColumnWidth(longestKeyLen);
    const valueWidth = getSettingsValueColumnWidth(inner, keyWidth);
    // Description column fills the remaining horizontal budget so every row
    // is exactly `inner` chars wide — values, descriptions, and the right edge
    // all stay flush in a rectangular block.
    //   2 leading + 2 (#) + 1 + keyWidth + 1 + valueWidth + 1 + descWidth = inner
    const descWidth = Math.max(20, inner - (2 + 2 + 1 + keyWidth + 1 + valueWidth + 1));
    const padKey = (k) => {
      const s = String(k || "");
      if (s.length <= keyWidth) return s.padEnd(keyWidth);
      // Defensive: if a future key exceeds the cap, ellipsis-truncate so the
      // value column stays aligned rather than shifting right.
      return `${s.slice(0, keyWidth - 1)}…`;
    };
    const hdr = `  ${"#".padStart(2)} ${"Key".padEnd(keyWidth)} ${"Value".padEnd(valueWidth)} ${"Description".padEnd(descWidth)}`;
    const sectionDivider = ` ${C.dim}${"-".repeat(Math.max(1, inner))}${C.reset}`;
    let rowIndex = 1;

    const pushSection = (title, subtitle = "") => {
      this._settingsSectionRows.push(lines.length);
      const rule = brandRule({ label: String(title).toLowerCase(), color: C.cyan, width: ruleWidth });
      const tail = subtitle ? `  ${C.dim}${subtitle}${C.reset}` : "";
      lines.push(`${rule}${tail}`);
    };
    const pushTableHeader = () => {
      lines.push(` ${C.dim}${hdr}${C.reset}`);
      lines.push(sectionDivider);
    };
    const pushEditableRow = (settingKey, value, desc, valueColor = C.cyan, options = {}) => {
      const isHighlighted = isHighlightedSetting(settingKey);
      const paddedKey = padKey(settingKey);
      const keyBase = options.dimmed && !isHighlighted
        ? `${C.dim}${paddedKey}${C.reset}`
        : paddedKey;
      const keyStr = isHighlighted ? `${C.yellow}${paddedKey}${C.reset}` : keyBase;
      const descColor = options.dimmed ? C.dim : C.dim;
      this._settingsRowMap.set(settingKey, lines.length);
      // Pad/truncate description to `descWidth` so every row ends at the same
      // column — gives the table a uniform rectangular silhouette.
      const descCell = fit(`${descColor}${desc || ""}${C.reset}`, descWidth);
      lines.push(`  ${String(rowIndex).padStart(2)} ${keyStr} ${fit(`${valueColor}${value || ""}${C.reset}`, valueWidth)} ${descCell}`);
      rowIndex += 1;
    };

    // Resolution order:
    //   1. entry's own .description (set by builders like _getSkillSettingEntries)
    //   2. catalog entry's description (the canonical doc string)
    //   3. placeholder so every row has tooltip text
    const resolveDesc = (displayKey, entry) => {
      if (entry?.description) return entry.description;
      const catalog = getCatalogEntry(toStorageSettingKey(displayKey));
      if (catalog?.description) return catalog.description;
      return "(no description; add one in SETTINGS_CATALOG)";
    };

    // ── Database settings, split into focused groups per pane ─────────────
    const settingsByKey = new Map((settingsSnapshot.dbSettings || []).map((s) => [s.setting_key, s]));
    const renderDbGroupsForPane = (paneId) => {
      const placedKeys = new Set();
      for (const group of SETTINGS_GROUPS) {
        if (group.pane !== paneId) continue;
        const present = group.keys.filter((k) => settingsByKey.has(k));
        if (present.length === 0) continue;
        pushSection(group.label, "(press 'e' to edit)");
        pushTableHeader();
        for (const key of present) {
          const s = settingsByKey.get(key);
          pushEditableRow(s.setting_key, s.setting_value || "", resolveDesc(key, s));
          placedKeys.add(key);
        }
        lines.push("");
      }
      // Surface any catalog keys routed to this pane but not yet placed in a
      // group, so new settings remain visible until explicitly slotted into
      // SETTINGS_GROUPS.
      const ungrouped = (dbSettingsByPane[paneId] || []).filter((s) => !placedKeys.has(s.setting_key));
      if (ungrouped.length > 0) {
        pushSection("misc", "(unmapped — add to SETTINGS_GROUPS)");
        pushTableHeader();
        for (const s of ungrouped) {
          pushEditableRow(s.setting_key, s.setting_value || "", resolveDesc(s.setting_key, s));
        }
        lines.push("");
      }
    };

    const renderProvidersPane = () => {
      pushSection("Provider Configuration", "(most commonly adjusted)");
      pushTableHeader();
      for (const s of providerSettings) {
        const envNote = s.source === "global" && s.env_value
          ? ` overrides env${s.env_value ? `; env=${s.env_value}` : ""}`
          : s.source === "env" && s.db_value
            ? ` env fallback${s.db_value ? `; saved global=${s.db_value}` : ""}`
            : "";
        const isDelegatorInactive = s.setting_key === "provider_delegator" && delegationMode === "js";
        const desc = `${s.description} (${s.source}${envNote})${isDelegatorInactive ? " — currently handled by system" : ""}`;
        const valueColor = isDelegatorInactive ? C.dim : C.cyan;
        pushEditableRow(s.setting_key, formatProviderSettingValue(s), desc, valueColor, { dimmed: isDelegatorInactive });
      }
      for (const s of delegationSettings) {
        pushEditableRow(s.setting_key, s.setting_value || "", `${s.description} (${s.source})`);
      }
      for (const s of artifactSettings) {
        pushEditableRow(s.setting_key, s.setting_value || "", s.description || "");
      }
      lines.push("");

      if (providerUsageSettings.length > 0) {
        pushSection("Provider Usage Limits", `(${getAccountSettingsPathForDisplay()})`);
        pushTableHeader();
        for (const s of providerUsageSettings) {
          const baseDesc = s.description || "";
          const liveHint = getProviderUsageSettingHint(s.setting_key, providerUsageWindowMap);
          const desc = liveHint ? `${baseDesc} (${liveHint})` : baseDesc;
          pushEditableRow(s.setting_key, s.setting_value || "", desc);
        }
        lines.push("");
      }

      if (modelSettings.length > 0) {
        pushSection("Provider Models", "(editable when provider credentials are available)");
        pushTableHeader();
        for (const s of modelSettings) {
          const source = s.source || "default";
          const desc = `${s.description} (${s.provider}, ${source}; using ${s.effective_model || "?"})`;
          const displayValue = formatModelSettingDisplayValue(s);
          const valueColor = s.setting_value ? C.cyan : C.dim;
          pushEditableRow(s.setting_key, displayValue, desc, valueColor);
        }
        lines.push("");
      }

      renderDbGroupsForPane("providers");

      // Secrets stay env-only; show which ones are present without ever
      // rendering any part of the value.
      pushSection("Credential Keys", "(env-only; values are never shown)");
      const envVars = [
        ["OPENAI_API_KEY", "OpenAI API key (openai)"],
        ["CODEX_API_KEY", "Optional Codex CLI API key"],
        ["XAI_API_KEY", "xAI API key (grok)"],
        ["CLAUDE_CODE_OAUTH_TOKEN", "Claude OAuth token"],
      ];
      for (const [key, label] of envVars) {
        if (process.env[key]) {
          lines.push(`  ${C.green}✓${C.reset} ${C.bold}${key.padEnd(30)}${C.reset} ${C.green}configured${C.reset}  ${C.dim}${label}${C.reset}`);
        } else {
          lines.push(`  ${C.dim}· ${key.padEnd(30)} not set     ${label}${C.reset}`);
        }
      }
      lines.push("");
    };

    const renderAtlasPane = () => {
      renderDbGroupsForPane("atlas");
    };

    const renderGeneralPane = () => {
      renderDbGroupsForPane("general");

      pushSection("Skills", "(planner-selected; new skills default on)");
      if (skillSettings.length === 0) {
        lines.push(`  ${C.dim}No skills found in the remote prompt bundle.${C.reset}`);
      } else {
        pushTableHeader();
        for (const s of skillSettings) {
          pushEditableRow(s.setting_key, s.setting_value || "", s.description || "");
        }
      }
      lines.push("");

      pushSection("Project Database", "(opt-in agent SQL access; press 'e' to edit)");
      pushTableHeader();
      for (const s of projectDbSettings) {
        pushEditableRow(s.setting_key, s.setting_value || "", s.description || "");
      }
      lines.push("");

      pushSection("Paths");
      const dbPath = getRuntimeDbPath(this.projectDir);
      const reportsDir = path.resolve(path.dirname(dbPath), "reports");
      lines.push(`  ${C.dim}Project:${C.reset}  ${this.projectDir}`);
      lines.push(`  ${C.dim}Database:${C.reset} ${dbPath}`);
      lines.push(`  ${C.dim}Reports:${C.reset}  ${reportsDir}`);
      lines.push("");
    };

    const renderDebugPane = () => {
      renderDbGroupsForPane("debug");
    };

    if (settingsPane === "providers") {
      renderProvidersPane();
    } else if (settingsPane === "atlas") {
      renderAtlasPane();
    } else if (settingsPane === "general") {
      renderGeneralPane();
    } else if (settingsPane === "debug") {
      renderDebugPane();
    } else {
      // "all" — non-interactive snapshots and tests render every pane in the
      // same order paneEditableSettings concatenates them.
      renderProvidersPane();
      renderAtlasPane();
      renderGeneralPane();
      renderDebugPane();
    }

    return lines;
  }

}
