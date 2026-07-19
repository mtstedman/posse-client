// Versioned, bounded provider-usage projection consumed by fleet clients.

import { PROVIDER_USAGE_BUDGET_DEFS } from "../../../catalog/settings.js";

export const PROVIDER_USAGE_PROTOCOL = "posse.provider_usage.v1";
export const PROVIDER_USAGE_MAX_BYTES = 256 * 1024;

const MAX_PROVIDERS = 32;
const MAX_WINDOWS_PER_PROVIDER = 16;
const MAX_ID_CHARS = 64;
const MAX_LABEL_CHARS = 120;
const MAX_SOURCE_CHARS = 120;

function boundedText(value, maxChars) {
  if (value == null) return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, maxChars) : null;
}

function providerId(value) {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_CHARS);
  return clean || null;
}

function providerLabel(id, value = null) {
  const explicit = boundedText(value, MAX_LABEL_CHARS);
  if (explicit) return explicit;
  if (id === "openai") return "OpenAI";
  if (id === "codex") return "Codex";
  if (id === "claude") return "Claude";
  if (id === "grok") return "Grok";
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "Provider";
}

function providerSource(value) {
  const raw = String(value || "").trim();
  if (!/^[a-z0-9._:-]+$/i.test(raw)) return null;
  const clean = raw.toLowerCase().slice(0, MAX_SOURCE_CHARS);
  return clean || null;
}

function finiteNonNegative(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clampPercent(value) {
  const parsed = finiteNonNegative(value);
  return parsed == null ? null : Math.min(100, parsed);
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function usageQualifier(provider) {
  if (provider === "claude") return "api_equivalent_estimate";
  if (provider === "codex") return "cli_estimate";
  return "billed_estimate";
}

function normalizeUsageRecords(records = []) {
  const byProvider = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = providerId(record?.provider ?? record?.id);
    if (!id) continue;
    const current = byProvider.get(id) || {
      calls: 0,
      rawTokens: 0,
      billableTokens: 0,
      costUsd: 0,
    };
    current.calls += finiteNonNegative(record?.callCount ?? record?.call_count) || 0;
    current.rawTokens += finiteNonNegative(record?.usedTokens ?? record?.raw_tokens ?? record?.tokens) || 0;
    const billable = finiteNonNegative(record?.usedBillableTokens ?? record?.billable_tokens);
    current.billableTokens += billable == null
      ? finiteNonNegative(record?.usedTokens ?? record?.raw_tokens ?? record?.tokens) || 0
      : billable;
    current.costUsd += finiteNonNegative(record?.costUsd ?? record?.cost_usd) || 0;
    byProvider.set(id, current);
  }
  return byProvider;
}

function normalizeProviderWindow(window) {
  if (!window || typeof window !== "object") return null;
  const key = String(window.key || window.kind || "").trim().toLowerCase();
  const kind = key === "session" || key === "week" ? key : "provider-specific";
  const unlimited = window.unlimited === true;
  const durationMs = finiteNonNegative(window.durationMs);
  return {
    kind,
    label: boundedText(window.label, MAX_LABEL_CHARS)
      || (kind === "session" ? "Session" : kind === "week" ? "Week" : "Provider window"),
    duration_minutes: durationMs == null ? null : durationMs / 60_000,
    reset_at: unlimited ? null : isoTimestamp(window.resetAt),
    unlimited,
    utilization_pct: unlimited ? null : clampPercent(window.utilizationPct ?? window.observedPct),
    used_tokens: unlimited ? null : finiteNonNegative(window.usedTokens),
    limit_tokens: unlimited ? null : finiteNonNegative(window.limitTokens),
    remaining_tokens: unlimited ? null : finiteNonNegative(window.remainingTokens),
  };
}

function safeProviderDetail(summary) {
  const source = String(summary?.source || "").toLowerCase();
  if (summary?.stale === true) return "provider usage refresh unavailable; showing stale data";
  if (source.includes("unavailable")) return "provider usage unavailable";
  if (summary?.detail) return "provider diagnostic detail omitted";
  return null;
}

function readConfiguredBudgets(readSetting) {
  const result = [];
  for (const def of PROVIDER_USAGE_BUDGET_DEFS) {
    let rawValue = null;
    try {
      rawValue = readSetting(def.settingKey);
    } catch {
      rawValue = null;
    }
    if (rawValue == null || String(rawValue).trim() === "") continue;
    result.push({ ...def, rawValue, limit: finiteNonNegative(rawValue) });
  }
  return result;
}

function projectBudget(def, { summary, currentRun, today, runStartedAt }) {
  let spent = null;
  let measurable = false;
  let detail = null;

  if (def.limit == null) {
    detail = "configured budget value is invalid";
  } else if (def.kind === "image") {
    detail = "image spend unavailable";
  } else if (def.unit === "usd" && def.kind === "daily") {
    spent = today?.costUsd || 0;
    measurable = true;
  } else if (def.unit === "usd" && def.kind === "run") {
    if (!runStartedAt) {
      detail = "current scheduler run unavailable";
    } else {
      spent = currentRun?.costUsd || 0;
      measurable = true;
    }
  } else if (def.unit === "percent_of_session") {
    const session = Array.isArray(summary?.windows)
      ? summary.windows.find((window) => window?.key === "session")
      : null;
    const sessionLimit = finiteNonNegative(session?.limitTokens);
    const trustedLimit = sessionLimit != null
      && sessionLimit > 0
      && session?.limitSource !== "inferred_percent";
    if (!runStartedAt) {
      detail = "current scheduler run unavailable";
    } else if (session?.unlimited === true) {
      detail = "session capacity is unlimited";
    } else if (!trustedLimit) {
      detail = "trusted session token capacity unavailable";
    } else {
      spent = ((currentRun?.rawTokens || 0) / sessionLimit) * 100;
      measurable = true;
    }
  }

  return {
    kind: def.kind,
    setting_key: def.settingKey,
    unit: def.unit,
    configured: true,
    limit: def.limit,
    spent,
    measurable,
    detail,
  };
}

export function buildProviderUsageDocument({
  summaries = [],
  currentRunUsage = [],
  todayUsage = [],
  runStartedAt = null,
  generatedAt = new Date(),
  readSetting = () => null,
} = {}) {
  const normalizedRunStartedAt = isoTimestamp(runStartedAt);
  const normalizedGeneratedAt = isoTimestamp(generatedAt) || new Date().toISOString();
  const currentRunByProvider = normalizeUsageRecords(currentRunUsage);
  const todayByProvider = normalizeUsageRecords(todayUsage);
  const summariesByProvider = new Map();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const id = providerId(summary?.provider ?? summary?.id);
    if (id && !summariesByProvider.has(id)) summariesByProvider.set(id, summary);
  }

  const configuredBudgets = readConfiguredBudgets(readSetting);
  const ids = new Set([
    ...summariesByProvider.keys(),
    ...currentRunByProvider.keys(),
    ...todayByProvider.keys(),
    ...configuredBudgets.map((budget) => budget.provider),
  ]);
  const providerIds = [...ids].sort().slice(0, MAX_PROVIDERS);
  const providers = providerIds.map((id) => {
    const summary = summariesByProvider.get(id) || null;
    const currentRun = currentRunByProvider.get(id) || null;
    const today = todayByProvider.get(id) || null;
    const windows = (Array.isArray(summary?.windows) ? summary.windows : [])
      .slice(0, MAX_WINDOWS_PER_PROVIDER)
      .map(normalizeProviderWindow)
      .filter(Boolean);
    const budgets = configuredBudgets
      .filter((budget) => budget.provider === id)
      .map((budget) => projectBudget(budget, {
        summary,
        currentRun,
        today,
        runStartedAt: normalizedRunStartedAt,
      }));

    return {
      id,
      label: providerLabel(id, summary?.label),
      source: providerSource(summary?.source)
        || (summary ? "unknown" : "posse-agent-calls"),
      stale: summary?.stale === true,
      detail: safeProviderDetail(summary),
      current_run: {
        calls: normalizedRunStartedAt ? currentRun?.calls || 0 : null,
        raw_tokens: normalizedRunStartedAt ? currentRun?.rawTokens || 0 : null,
        billable_tokens: normalizedRunStartedAt ? currentRun?.billableTokens || 0 : null,
        cost_usd: normalizedRunStartedAt ? currentRun?.costUsd || 0 : null,
        qualifier: usageQualifier(id),
      },
      today: {
        cost_usd: today?.costUsd || 0,
      },
      windows,
      budgets,
    };
  });

  return {
    protocol: PROVIDER_USAGE_PROTOCOL,
    generated_at: normalizedGeneratedAt,
    run_started_at: normalizedRunStartedAt,
    providers,
  };
}

export function serializeProviderUsageDocument(document) {
  const output = `${JSON.stringify(document)}\n`;
  const size = Buffer.byteLength(output, "utf8");
  if (size > PROVIDER_USAGE_MAX_BYTES) {
    throw new Error(`provider usage document exceeds ${PROVIDER_USAGE_MAX_BYTES} bytes`);
  }
  return output;
}
