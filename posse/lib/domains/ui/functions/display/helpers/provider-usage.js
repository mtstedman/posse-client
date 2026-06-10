// lib/display/helpers/provider-usage.js

import { C } from "../../../../providers/functions/claude.js";
import {
  getConfiguredProviderUsage,
  getConfiguredProviderUsageAsync,
  getProviderUsage,
} from "../../../../providers/functions/provider.js";
import { getDb } from "../../../../../shared/storage/functions/index.js";
import { providerUsageRuntimeCache } from "../../../../providers/classes/usage-runtime-cache-singleton.js";
import {
  _fmtTokens,
  _fmtUsd,
  fit,
} from "./formatters.js";
import {
  brandGauge,
  brandRule,
  providerBrandColor,
} from "./brand.js";
import { estimateCallCost } from "../../../../billing/functions/pricing.js";
import { EVENT_TYPES } from "../../../../../catalog/event.js";

export const PROVIDER_USAGE_REFRESH_MS = 2 * 60 * 1000;

providerUsageRuntimeCache.configure({
  readSync: (opts = {}) => ({
    summaries: getConfiguredProviderUsage(opts) || [],
    currentRunProviderUsage: getCurrentRunProviderUsage(opts),
  }),
  readAsync: async (opts = {}) => ({
    summaries: await getConfiguredProviderUsageAsync(opts) || [],
    currentRunProviderUsage: getCurrentRunProviderUsage(opts),
  }),
});

export function getProviderUsageSummaryCache() {
  return providerUsageRuntimeCache.snapshot();
}

export function _refreshProviderUsageSummaryCache(opts = {}) {
  return providerUsageRuntimeCache.refresh(opts);
}

export async function _refreshProviderUsageSummaryCacheAsync(opts = {}) {
  return await providerUsageRuntimeCache.refreshAsync(opts);
}

export async function _refreshProviderUsageSummaryCacheIfChanged(opts = {}) {
  return await providerUsageRuntimeCache.refreshIfChanged(opts);
}

export function _formatPct(value) {
  if (!Number.isFinite(value)) return "0%";
  if (value >= 10) return `${value.toFixed(1)}%`;
  if (value >= 1) return `${value.toFixed(2)}%`;
  return `${value.toFixed(3)}%`;
}

export function _taskProviderBudgetLines(data, summaries = null) {
  const agentCalls = Array.isArray(data?.agentCalls) ? data.agentCalls : [];
  if (!agentCalls.length) return [];

  const providerTaskTokens = new Map();
  for (const call of agentCalls) {
    const provider = String(call.provider || "").trim().toLowerCase();
    if (!provider) continue;
    const total = (call.input_tokens || 0) + (call.output_tokens || 0);
    if (total <= 0) continue;
    providerTaskTokens.set(provider, (providerTaskTokens.get(provider) || 0) + total);
  }
  if (!providerTaskTokens.size) return [];

  const usageSummaries = Array.isArray(summaries) ? summaries.filter(Boolean) : [];
  const summarizedProviders = new Set(
    usageSummaries
      .map((summary) => String(summary?.provider || "").trim().toLowerCase())
      .filter(Boolean),
  );
  for (const provider of providerTaskTokens.keys()) {
    if (summarizedProviders.has(provider)) continue;
    try {
      const summary = getProviderUsage(provider);
      if (summary) {
        usageSummaries.push(summary);
        const summaryProvider = String(summary?.provider || "").trim().toLowerCase();
        if (summaryProvider) summarizedProviders.add(summaryProvider);
      }
    } catch {
      // Optional provider usage modules may be unavailable.
    }
  }

  const lines = [];
  for (const summary of usageSummaries) {
    const provider = String(summary?.provider || "").trim().toLowerCase();
    if (!provider || !providerTaskTokens.has(provider)) continue;
    const session = Array.isArray(summary?.windows) ? summary.windows.find((w) => w.key === "session") : null;
    const taskTokens = providerTaskTokens.get(provider) || 0;
    if (taskTokens <= 0) continue;
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    const limit = Number(session?.limitTokens);
    const trustedLimit = Number.isFinite(limit) && limit > 0 && session?.limitSource !== "inferred_percent";
    if (provider === "claude" && trustedLimit) {
      const pct = (taskTokens / limit) * 100;
      lines.push(` ${C.bold}${label}:${C.reset} This task consumed ${_formatPct(pct)} of the session token budget ${C.dim}(${_fmtTokens(taskTokens)} / ${_fmtTokens(limit)})${C.reset}`);
      continue;
    }
    lines.push(` ${C.bold}${label}:${C.reset} This task consumed ${C.dim}${_fmtTokens(taskTokens)} tokens (session)${C.reset}`);
  }

  return lines;
}

function _estimateRunCallCost(row) {
  const provider = String(row?.provider || "").trim().toLowerCase();
  const useKnownCost = provider !== "codex";
  const est = estimateCallCost({
    provider,
    modelName: row?.model_name,
    modelTier: row?.model_tier,
    inputTokens: row?.input_tokens,
    outputTokens: row?.output_tokens,
    cachedInputTokens: row?.cached_input_tokens,
    knownCostUsd: useKnownCost ? row?.cost_estimate_usd : null,
  });
  return Number.isFinite(est.costUsd) ? Math.max(0, est.costUsd) : 0;
}

function _aggregateProviderUsageRows(rows = []) {
  const byProvider = new Map();
  for (const row of rows) {
    const provider = String(row?.provider || "").trim().toLowerCase();
    if (!provider) continue;
    const inputTokens = Math.max(0, Number(row?.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(row?.output_tokens) || 0);
    const usedTokens = inputTokens + outputTokens;
    if (usedTokens <= 0) continue;
    const existing = byProvider.get(provider) || {
      provider,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedTokens: 0,
      costUsd: 0,
      callCount: 0,
      firstSeen: row?.created_at || null,
    };
    existing.usedInputTokens += inputTokens;
    existing.usedOutputTokens += outputTokens;
    existing.usedTokens += usedTokens;
    existing.costUsd += _estimateRunCallCost({ ...row, provider });
    existing.callCount += 1;
    if (!existing.firstSeen || (row?.created_at && row.created_at < existing.firstSeen)) {
      existing.firstSeen = row.created_at;
    }
    byProvider.set(provider, existing);
  }
  return [...byProvider.values()].sort((a, b) => {
    const first = String(a.firstSeen || "").localeCompare(String(b.firstSeen || ""));
    return first || String(a.provider).localeCompare(String(b.provider));
  });
}

export function getProviderUsageSince({ sinceIso = null, untilIso = null } = {}) {
  try {
    const db = getDb();
    const where = [
      "provider IS NOT NULL",
      "TRIM(provider) <> ''",
      "COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0",
    ];
    const params = [];
    if (sinceIso) {
      where.push("created_at >= ?");
      params.push(sinceIso);
    }
    if (untilIso) {
      where.push("created_at < ?");
      params.push(untilIso);
    }
    const rows = db.prepare(`
      SELECT
        LOWER(TRIM(provider)) AS provider,
        model_name,
        model_tier,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        cost_estimate_usd,
        created_at
      FROM agent_calls
      WHERE ${where.join(" AND ")}
      ORDER BY created_at ASC, id ASC
    `).all(...params);
    return _aggregateProviderUsageRows(rows);
  } catch {
    return [];
  }
}

export function getCurrentRunProviderUsage({ runStartedAtIso = null } = {}) {
  if (!runStartedAtIso) return [];
  return getProviderUsageSince({ sinceIso: runStartedAtIso });
}

export function getTodayProviderUsage({ nowDate = new Date() } = {}) {
  const start = new Date(nowDate);
  start.setHours(0, 0, 0, 0);
  return getProviderUsageSince({ sinceIso: start.toISOString() });
}

export function getLatestRunStartedAtIso() {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT created_at
      FROM events
      WHERE event_type = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(EVENT_TYPES.SCHEDULER_STARTED);
    return row?.created_at || null;
  } catch {
    return null;
  }
}

function _providerLabel(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "openai") return "OPENAI";
  if (value === "grok") return "GROK";
  if (value === "codex") return "CODEX";
  if (value === "claude") return "CLAUDE";
  return value ? value.toUpperCase() : "PROVIDER";
}

function _normalizeRunUsage(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      provider: String(entry?.provider || "").trim().toLowerCase(),
      usedTokens: Number(entry?.usedTokens ?? entry?.tokens ?? 0) || 0,
      usedInputTokens: Number(entry?.usedInputTokens ?? entry?.inputTokens ?? 0) || 0,
      usedOutputTokens: Number(entry?.usedOutputTokens ?? entry?.outputTokens ?? 0) || 0,
      costUsd: Number(entry?.costUsd ?? entry?.cost_usd ?? 0) || 0,
      callCount: Number(entry?.callCount ?? entry?.call_count ?? 0) || 0,
      firstSeen: entry?.firstSeen || null,
    }))
    .filter((entry) => entry.provider && entry.usedTokens > 0);
}

function _summaryByProvider(summaries = []) {
  const map = new Map();
  for (const summary of summaries || []) {
    const provider = String(summary?.provider || "").trim().toLowerCase();
    if (provider && !map.has(provider)) map.set(provider, summary);
  }
  return map;
}

function _activeProviderSet(activeProviders) {
  if (!activeProviders) return new Set();
  const values =
    activeProviders instanceof Set
      ? Array.from(activeProviders)
      : Array.isArray(activeProviders)
        ? activeProviders
        : [activeProviders];

  return new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function _windowHasDisplaySignal(window) {
  if (!window || typeof window !== "object") return false;
  const usedTokens = Number(window.usedTokens);
  const limitTokens = Number(window.limitTokens);
  const utilizationPct = Number(window.utilizationPct);
  const observedPct = Number(window.observedPct);
  return (
    (Number.isFinite(usedTokens) && usedTokens > 0) ||
    (Number.isFinite(limitTokens) && limitTokens > 0) ||
    (Number.isFinite(utilizationPct) && utilizationPct > 0) ||
    (Number.isFinite(observedPct) && observedPct > 0)
  );
}

function _canRenderActiveProviderSummary(summary) {
  if (!summary || typeof summary !== "object") return false;
  const source = String(summary.source || "").trim().toLowerCase();
  if (source === "account-snapshot") return false;
  return Array.isArray(summary.windows) && summary.windows.some(_windowHasDisplaySignal);
}

function _includeActiveProviderPlaceholders(runUsage, summariesByProvider, activeProviders) {
  const active = _activeProviderSet(activeProviders);
  if (active.size === 0 || !(summariesByProvider instanceof Map)) return runUsage;

  const seen = new Set(runUsage.map((usage) => String(usage?.provider || "").trim().toLowerCase()).filter(Boolean));
  const additions = [];
  for (const provider of active) {
    if (seen.has(provider)) continue;
    const summary = summariesByProvider.get(provider);
    if (!_canRenderActiveProviderSummary(summary)) continue;
    additions.push({
      provider,
      usedTokens: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      costUsd: 0,
      callCount: 0,
      firstSeen: null,
    });
  }

  return additions.length > 0 ? runUsage.concat(additions) : runUsage;
}

function _windowPct(window) {
  if (Number.isFinite(window?.utilizationPct)) return Number(window.utilizationPct);
  if (Number.isFinite(window?.usedTokens)
    && Number.isFinite(window?.limitTokens)
    && window.limitTokens > 0
  ) {
    return (Number(window.usedTokens) / Number(window.limitTokens)) * 100;
  }
  return null;
}

export function _formatResetWindow(resetAt, nowMs = Date.now()) {
  const ts = Date.parse(resetAt);
  if (!Number.isFinite(ts)) return null;
  const diffMinutes = Math.max(0, Math.ceil((ts - nowMs) / 60000));
  if (diffMinutes <= 0) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function _resetSuffix(window, nowMs) {
  const reset = _formatResetWindow(window?.resetAt, nowMs);
  return reset ? ` ${C.dim}${reset}${C.reset}` : "";
}

function _providerCostQualifier(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "claude") return "API-equiv est";
  if (value === "codex") return "CLI est";
  return "billed est";
}

function _emptyProviderGauge({ width = 20 } = {}) {
  return {
    bar: `${C.dim}▕${"░".repeat(width)}▏${C.reset}`,
    pctText: `${C.dim} --%${C.reset}`,
    glyph: "",
    tierColor: C.dim,
    clamped: null,
  };
}

export function _buildQueueProviderUsageLines(width, maxLines, summaries = [], opts = {}) {
  if (maxLines <= 0) return [];
  const summariesByProvider = _summaryByProvider(summaries);
  let runUsage = _normalizeRunUsage(opts.currentRunProviderUsage ?? opts.runProviderUsage);
  if (runUsage.length === 0 && opts.runStartedAtIso) {
    runUsage = _normalizeRunUsage(getCurrentRunProviderUsage({ runStartedAtIso: opts.runStartedAtIso }));
  }
  runUsage = _includeActiveProviderPlaceholders(runUsage, summariesByProvider, opts.activeProviders);
  if (runUsage.length === 0) return [];

  const lines = [];
  const ruleWidth = Math.max(20, Math.min(width, 56));
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  for (const usage of runUsage) {
    const block = [];
    const brand = providerBrandColor(usage.provider);
    block.push(brandRule({ label: _providerLabel(usage.provider), color: brand, width: ruleWidth }));

    const tokens = _fmtTokens(usage.usedTokens);
    const costSuffix = usage.costUsd > 0
      ? `  ${C.dim}·${C.reset}  ${C.dim}${_fmtUsd(usage.costUsd)} ${_providerCostQualifier(usage.provider)}${C.reset}`
      : "";
    block.push(fit(`   ${C.bold}${brand}${tokens}${C.reset} ${C.dim}tok${C.reset}${costSuffix}`, Math.max(1, width - 1)));

    if (usage.provider === "claude" || usage.provider === "codex") {
      let summary = summariesByProvider.get(usage.provider);
      if (!summary) {
        try { summary = getProviderUsage(usage.provider, opts.providerUsageOpts || {}); } catch { /* ignore */ }
      }
      const session = summary?.windows?.find((window) => window.key === "session");
      const week = summary?.windows?.find((window) => window.key === "week");
      for (const [label, window] of [["S", session], ["W", week]]) {
        const pct = _windowPct(window);
        const gauge = brandGauge(pct) || _emptyProviderGauge();
        // Keep the row compact; color on the bar and percentage carries pressure.
        const tag = `${gauge.tierColor}[${label}]${C.reset}`;
        const resetSuffix = _resetSuffix(window, nowMs);
        const marker = gauge.glyph ? ` ${gauge.glyph}` : "";
        block.push(fit(
          `   ${tag} ${gauge.bar} ${gauge.pctText}${marker}${resetSuffix}`,
          Math.max(1, width - 1),
        ));
      }
    }
    if (lines.length + block.length > maxLines) {
      if (lines.length === 0) return block.slice(0, maxLines);
      break;
    }
    lines.push(...block);
  }

  return lines.slice(0, maxLines);
}
