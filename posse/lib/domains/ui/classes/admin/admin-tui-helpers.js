// admin-tui-helpers.js — module-level pure helpers extracted from AdminTUI.js.
//
// These are stateless module functions (no `this`) used by the AdminTUI class
// and its render builders: setting read/write wrappers that degrade gracefully
// when the runtime DB is busy, model/image-model setting resolution, provider
// dashboard labels, and the status/line sanitizers. Kept here (a sibling of the
// stateful AdminTUI class) following the same split the settings-controller and
// admin-atlas-rollups modules use.

import { runtimeDbLooksBusyOrCorrupt, getModelProviderDefaults } from "../../functions/admin/shared-helpers.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { listSettings, getSetting } from "../../../queue/functions/index.js";
import { isProviderSelectable } from "../../../providers/functions/provider.js";
import { jobReportStatus } from "../display/Display.js";
import { FAILED_JOB_STATUSES } from "../../../../catalog/job.js";
import { getAccountSetting } from "../../../settings/functions/account-settings.js";
import { _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { stripAnsi } from "../../../../shared/format/functions/ansi.js";
import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_SETTING_DEFS,
  getDefaultTierModel,
  getImageModelOptions,
  getTextModelOptions,
} from "../../../providers/functions/model-catalog.js";

export const PROVIDER_USAGE_SETTING_DEFS = [
  { provider: "claude", key: "claude_limit_tokens_session", label: "Claude session token limit", description: "Token cap for Claude's 5-hour rolling session window." },
  { provider: "claude", key: "claude_limit_tokens_week", label: "Claude weekly token limit", description: "Token cap for Claude's 7-day rolling weekly window." },
  { provider: "claude", key: "claude_observed_pct_session", label: "Claude session observed %", description: "Observed Claude session usage percent; saving this calibrates the 5-hour token cap." },
  { provider: "claude", key: "claude_observed_pct_week", label: "Claude weekly observed %", description: "Observed Claude weekly usage percent; saving this calibrates the 7-day token cap." },
];

export const MODEL_SETTING_KEYS = new Set(MODEL_SETTING_DEFS.map((def) => def.key));
export const PROVIDER_USAGE_SETTING_KEYS = new Set(PROVIDER_USAGE_SETTING_DEFS.map((def) => def.key));

export function getHistoryJobPresentation(job, jobs = []) {
  const rawStatus = job?.status || "unknown";
  const attemptCount = Number(job?.attempts || job?.attempt_count || 0) || 0;
  const displayStatus = jobReportStatus(job, jobs);

  if ((rawStatus === "queued" || rawStatus === "leased" || rawStatus === "running") && attemptCount > 1) {
    return {
      displayStatus: "retrying",
      icon: `${C.yellow}↻`,
      label: `retrying after ${attemptCount - 1} failed attempt${attemptCount - 1 === 1 ? "" : "s"}`,
      attemptTag: `${attemptCount} attempts so far`,
    };
  }

  if (rawStatus === "succeeded" && attemptCount > 1) {
    return {
      displayStatus: "recovered",
      icon: `${C.yellow}↻`,
      label: `recovered after retry`,
      attemptTag: `${attemptCount} attempts`,
    };
  }

  if (displayStatus === "recovered") {
    return {
      displayStatus,
      icon: `${C.yellow}↻`,
      label: "recovered",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempts` : null,
    };
  }

  if (displayStatus === "succeeded") {
    return {
      displayStatus,
      icon: `${C.green}✓`,
      label: "succeeded",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (FAILED_JOB_STATUSES.includes(displayStatus)) {
    return {
      displayStatus,
      icon: `${C.red}✗`,
      label: displayStatus,
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (rawStatus === "running") {
    return { displayStatus: rawStatus, icon: `${C.yellow}▶`, label: "running", attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null };
  }

  return {
    displayStatus: rawStatus,
    icon: `${C.dim}·`,
    label: rawStatus,
    attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
  };
}

export function normalizeAdminLine(str) {
  // Every tab line passes through here before rendering, so this is the choke
  // point that keeps untrusted bodies (prompt/output logs, tool summaries,
  // repo file contents) from injecting non-SGR terminal escapes.
  return _sanitizeDisplayLine(String(str ?? "")
    .replace(/\u00c3\u00a2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u20ac\u201d/g, "\u2014"));
}

export function sanitizeAdminStatusText(value) {
  return stripAnsi(_sanitizeDisplayLine(value)).trim();
}

export function getEffectiveModelSetting(def) {
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

export function getEffectiveImageModelSetting(def) {
  const stored = safeGetSetting(def.key);
  const choices = getImageModelOptions(def.provider, { currentValue: stored });
  const effectiveModel = choices.some((choice) => choice.value === stored)
    ? stored
    : (choices[0]?.value || "");
  return {
    storedValue: stored || "",
    effectiveModel,
    source: stored ? "global" : "default",
  };
}

export function getModelChoicesForEntry(entry) {
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

export function getSelectableImageProviders() {
  return IMAGE_PROVIDER_OPTIONS.filter((option) => isProviderSelectable(option.value));
}

export function providerDashboardLabel(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "claude") return "Claude Agent";
  if (value === "openai") return "OpenAI";
  if (value === "codex") return "Codex";
  if (value === "grok") return "Grok";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Provider";
}

export function providerCostQualifier(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "claude") return "API-equivalent";
  if (value === "codex") return "CLI estimate";
  return "billed estimate";
}

export function providerDailyBudgetSettingKey(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "openai") return "openai_daily_budget_usd";
  if (value === "grok") return "grok_daily_budget_usd";
  return null;
}

export function renderUsdUsageBar(usedUsd, budgetUsd, width = 18) {
  const safeWidth = Math.max(8, width | 0);
  if (!(budgetUsd > 0)) return `${C.dim}[${"?".repeat(safeWidth)}]${C.reset}`;
  const ratio = Math.max(0, Math.min(1, usedUsd / budgetUsd));
  const filled = Math.max(0, Math.min(safeWidth, Math.round(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  const barColor = ratio >= 0.9 ? C.red : ratio >= 0.75 ? C.yellow : C.green;
  return `${C.dim}[${C.reset}${barColor}${"#".repeat(filled)}${C.dim}${".".repeat(empty)}${C.reset}${C.dim}]${C.reset}`;
}

export function shortRunStartLabel(iso) {
  if (!iso) return "current scheduler";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getProviderUsageStoredValue(settingKey) {
  const globalValue = getAccountSetting(settingKey);
  if (globalValue != null && String(globalValue).trim() !== "") return String(globalValue);
  return safeGetSetting(settingKey);
}

export function safeGetSetting(key) {
  if (runtimeDbLooksBusyOrCorrupt()) return null;
  try {
    return getSetting(key);
  } catch {
    return null;
  }
}

export function safeListSettings() {
  if (runtimeDbLooksBusyOrCorrupt()) return [];
  try {
    return listSettings();
  } catch {
    return [];
  }
}
