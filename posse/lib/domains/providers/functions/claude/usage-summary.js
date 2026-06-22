import fs from "fs";
import path from "path";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getAccountSetting, setAccountSettings } from "../../../settings/functions/account-settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import {
  getClaudeConfigDir,
  hasUsableClaudeOauthToken,
  onClaudeConfigDirChanged,
  readClaudeCredentials,
} from "./auth-state.js";

const CLAUDE_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week", durationMs: 7 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_CLAUDE_USAGE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_CLAUDE_USAGE_BACKOFF_MS = 5 * 60 * 1000;
const CLAUDE_USAGE_SETTING_KEYS = {
  sessionUsed: "claude_session_tokens",
  sessionMax: "claude_session_max",
  sessionResetAt: "claude_session_reset_at",
  weekUsed: "claude_weekly_tokens",
  weekMax: "claude_weekly_max",
  weekResetAt: "claude_weekly_reset_at",
  subscriptionType: "claude_usage_subscription_type",
  rateLimitTier: "claude_usage_rate_limit_tier",
  source: "claude_usage_source",
  lastUpdated: "claude_usage_last_updated",
};
const CLAUDE_USAGE_DISK_CACHE_DIR = path.join("cache", "posse");
const CLAUDE_USAGE_DISK_CACHE_FILE = "claude-oauth-usage.json";

let usageSummaryCache = null;
let usageApiCache = null;
const usageFileCache = new Map();

export function resetClaudeUsageSummaryCache() {
  usageSummaryCache = null;
  usageApiCache = null;
  usageFileCache.clear();
}

onClaudeConfigDirChanged(resetClaudeUsageSummaryCache);

function readPositiveMsSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isAccountSettingsBusyError(err) {
  const code = String(err?.code || "").toUpperCase();
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = String(err?.message || err || "");
  return /\bSQLITE_(?:BUSY|LOCKED)\b|database is (?:locked|busy)/i.test(message);
}

function claudeUsageCacheMs() {
  return readPositiveMsSetting(SETTING_KEYS.CLAUDE_USAGE_CACHE_MS, DEFAULT_CLAUDE_USAGE_CACHE_MS);
}

function claudeUsageBackoffMs() {
  return readPositiveMsSetting(SETTING_KEYS.CLAUDE_USAGE_BACKOFF_MS, DEFAULT_CLAUDE_USAGE_BACKOFF_MS);
}

function isDeprecatedClaudeLogUsageEnabled() {
  return false;
}

function getClaudeUsageCachePath(configDir = getClaudeConfigDir()) {
  return path.join(configDir, CLAUDE_USAGE_DISK_CACHE_DIR, CLAUDE_USAGE_DISK_CACHE_FILE);
}

function readUsageSettingNumber(key) {
  const value = getAccountSetting(key);
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readUsageSettingString(key) {
  const value = getAccountSetting(key);
  if (value == null || String(value).trim() === "") return null;
  return String(value);
}

function isOauthUsageSettingsSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized.startsWith("anthropic-oauth-usage-api");
}

function buildClaudeUsageSummaryFromSettings(nowMs = Date.now(), { allowStale = false } = {}) {
  const lastUpdated = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.lastUpdated);
  if (!Number.isFinite(lastUpdated) || lastUpdated <= 0) return null;
  if (!allowStale && nowMs - lastUpdated > claudeUsageCacheMs()) return null;

  const sessionUsed = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.sessionUsed);
  const sessionMax = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.sessionMax);
  const weekUsed = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.weekUsed);
  const weekMax = readUsageSettingNumber(CLAUDE_USAGE_SETTING_KEYS.weekMax);
  const sessionResetAt = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.sessionResetAt);
  const weekResetAt = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.weekResetAt);
  const source = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.source);
  if (!isOauthUsageSettingsSource(source)) return null;
  const subscriptionType = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.subscriptionType);
  const rateLimitTier = readUsageSettingString(CLAUDE_USAGE_SETTING_KEYS.rateLimitTier);

  if (!Number.isFinite(sessionUsed) || !Number.isFinite(sessionMax) || !Number.isFinite(weekUsed) || !Number.isFinite(weekMax)) {
    return null;
  }

  const makeWindow = (key, label, durationMs, usedTokens, limitTokens, resetAt) => {
    const remainingTokens = Math.max(0, limitTokens - usedTokens);
    const utilizationPct = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : null;
    return {
      key,
      label,
      durationMs,
      utilizationPct,
      usageUnit: "tokens",
      usedTokens,
      limitTokens,
      remainingTokens,
      remainingPct: utilizationPct == null ? null : Math.max(0, 100 - utilizationPct),
      exhausted: remainingTokens <= 0,
      resetAt: resetAt || null,
    };
  };

  return {
    provider: "claude",
    source,
    subscriptionType,
    rateLimitTier,
    windows: [
      makeWindow("session", "Session (5h)", 5 * 60 * 60 * 1000, sessionUsed, sessionMax, sessionResetAt),
      makeWindow("week", "Week (7d)", 7 * 24 * 60 * 60 * 1000, weekUsed, weekMax, weekResetAt),
    ],
    fetchedAt: new Date(lastUpdated).toISOString(),
    cached: true,
    stale: allowStale && nowMs - lastUpdated > claudeUsageCacheMs(),
  };
}

function persistClaudeUsageSummaryToSettings(summary, nowMs = Date.now()) {
  if (!summary || !Array.isArray(summary.windows)) return;
  const session = summary.windows.find((window) => window.key === "session");
  const week = summary.windows.find((window) => window.key === "week");
  if (!session || !week) return;
  if (!Number.isFinite(session.usedTokens) || !Number.isFinite(session.limitTokens)) return;
  if (!Number.isFinite(week.usedTokens) || !Number.isFinite(week.limitTokens)) return;

  try {
    setAccountSettings({
      [CLAUDE_USAGE_SETTING_KEYS.sessionUsed]: String(session.usedTokens),
      [CLAUDE_USAGE_SETTING_KEYS.sessionMax]: String(session.limitTokens),
      [CLAUDE_USAGE_SETTING_KEYS.sessionResetAt]: session.resetAt || null,
      [CLAUDE_USAGE_SETTING_KEYS.weekUsed]: String(week.usedTokens),
      [CLAUDE_USAGE_SETTING_KEYS.weekMax]: String(week.limitTokens),
      [CLAUDE_USAGE_SETTING_KEYS.weekResetAt]: week.resetAt || null,
      [CLAUDE_USAGE_SETTING_KEYS.subscriptionType]: summary.subscriptionType || null,
      [CLAUDE_USAGE_SETTING_KEYS.rateLimitTier]: summary.rateLimitTier || null,
      [CLAUDE_USAGE_SETTING_KEYS.source]: summary.source || "anthropic-oauth-usage-api",
      [CLAUDE_USAGE_SETTING_KEYS.lastUpdated]: String(nowMs),
    });
  } catch (err) {
    if (isAccountSettingsBusyError(err)) return;
    throw err;
  }
}

function readClaudeUsageDiskCache(configDir = getClaudeConfigDir()) {
  const cachePath = getClaudeUsageCachePath(configDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.configDir && path.resolve(parsed.configDir) !== path.resolve(configDir)) return null;
    if (!parsed.summary || typeof parsed.summary !== "object") return null;
    return {
      cachedAt: Number(parsed.cachedAt) || 0,
      nextRetryAt: Number(parsed.nextRetryAt) || 0,
      configDir,
      summary: parsed.summary,
    };
  } catch {
    return null;
  }
}

function writeClaudeUsageDiskCache(configDir = getClaudeConfigDir(), entry = null) {
  const cachePath = getClaudeUsageCachePath(configDir);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    if (!entry) {
      if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      return;
    }
    fs.writeFileSync(cachePath, JSON.stringify({
      cachedAt: entry.cachedAt || Date.now(),
      nextRetryAt: entry.nextRetryAt || 0,
      configDir,
      summary: entry.summary || null,
    }, null, 2), "utf8");
  } catch {
    // Best-effort cache only.
  }
}

function readClaudeLimitSetting(key) {
  const globalVal = getAccountSetting(key);
  if (globalVal != null && String(globalVal).trim() !== "") {
    const parsed = parseInt(String(globalVal).trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  try {
    const stored = getSetting(key);
    if (stored != null && String(stored).trim() !== "") {
      const parsed = parseInt(String(stored).trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Ignore DB-read failures and fall back to null.
  }

  return null;
}

function getClaudeUsageLimits() {
  return {
    session: readClaudeLimitSetting("claude_limit_tokens_session"),
    week: readClaudeLimitSetting("claude_limit_tokens_week"),
  };
}

function listClaudeUsageFiles(dir) {
  const files = [];
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }

  return files;
}

function summarizeClaudeUsageEntries(entries, nowMs, limits) {
  const windows = CLAUDE_USAGE_WINDOW_DEFS.map((def) => {
    const cutoff = nowMs - def.durationMs;
    const matching = entries.filter((entry) => entry.timestampMs >= cutoff);
    const usedTokens = matching.reduce((sum, entry) => sum + entry.totalTokens, 0);
    const oldestTs = matching.reduce((min, entry) => Math.min(min, entry.timestampMs), Number.POSITIVE_INFINITY);
    const limitTokens = limits[def.key] ?? null;
    const remainingTokens = limitTokens == null ? null : Math.max(0, limitTokens - usedTokens);
    const resetAt = Number.isFinite(oldestTs) ? new Date(oldestTs + def.durationMs).toISOString() : null;

    return {
      key: def.key,
      label: def.label,
      durationMs: def.durationMs,
      usedTokens,
      limitTokens,
      remainingTokens,
      resetAt,
    };
  });

  return windows;
}

function buildUsageWindowFromUtilization({
  key,
  label,
  durationMs,
  utilizationPct,
  resetAt,
  limitTokens = null,
}) {
  const pct = Number.isFinite(utilizationPct) ? Math.min(100, Math.max(0, utilizationPct)) : 0;
  const ratio = pct / 100;
  const usedTokens = limitTokens != null ? Math.round(limitTokens * ratio) : null;
  const remainingTokens = limitTokens != null ? Math.max(0, limitTokens - usedTokens) : null;
  return {
    key,
    label,
    durationMs,
    utilizationPct: pct,
    usageUnit: limitTokens != null ? "tokens" : "percent",
    usedTokens,
    limitTokens,
    remainingTokens,
    remainingPct: Math.max(0, 100 - pct),
    exhausted: pct >= 100 || (limitTokens != null && remainingTokens <= 0),
    resetAt: resetAt || null,
  };
}

function enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs) {
  if (!summary || !Array.isArray(summary.windows) || summary.windows.length === 0) return summary;
  const targets = summary.windows.filter((w) =>
    (w?.key === "session" || w?.key === "week") &&
    Number.isFinite(w.utilizationPct) &&
    (w.usedTokens == null || w.limitTokens == null)
  );
  if (targets.length === 0) return summary;

  let entries;
  try {
    entries = loadClaudeUsageEntries(configDir, nowMs);
  } catch {
    return summary;
  }
  if (!Array.isArray(entries) || entries.length === 0) return summary;

  const localByKey = new Map(
    summarizeClaudeUsageEntries(entries, nowMs, {}).map((w) => [w.key, w])
  );

  for (const win of targets) {
    const local = localByKey.get(win.key);
    const used = local?.usedTokens;
    if (!Number.isFinite(used) || used <= 0) continue;
    if (win.usedTokens == null) win.usedTokens = used;
    if (win.limitTokens == null && win.utilizationPct > 0) {
      const inferred = Math.max(used, Math.ceil(used / (win.utilizationPct / 100)));
      if (Number.isFinite(inferred) && inferred > 0) {
        win.limitTokens = inferred;
        win.limitSource = "inferred_percent";
        win.usageUnit = "tokens";
        win.remainingTokens = Math.max(0, inferred - win.usedTokens);
        win.remainingPct = Math.max(0, 100 - win.utilizationPct);
        win.exhausted = win.remainingTokens <= 0;
      }
    } else if (win.limitTokens != null) {
      win.remainingTokens = Math.max(0, win.limitTokens - win.usedTokens);
    }
  }

  return summary;
}

function normalizeClaudeOauthUsageResponse(payload, nowMs, limits) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const windows = [];
  const addWindow = (key, label, durationMs, period, limitTokens = null) => {
    if (!period || typeof period !== "object") return;
    const utilizationPct = Number(period.utilization);
    if (!Number.isFinite(utilizationPct)) return;
    windows.push(buildUsageWindowFromUtilization({
      key,
      label,
      durationMs,
      utilizationPct,
      resetAt: period.resets_at || period.resetAt || null,
      limitTokens,
    }));
  };

  addWindow("session", "Session (5h)", 5 * 60 * 60 * 1000, raw.five_hour, limits.session ?? null);
  addWindow("week", "Week (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day, limits.week ?? null);
  addWindow("week_sonnet", "Week Sonnet (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day_sonnet, null);
  addWindow("week_opus", "Week Opus (7d)", 7 * 24 * 60 * 60 * 1000, raw.seven_day_opus, null);

  if (raw.extra_usage && typeof raw.extra_usage === "object") {
    const amountUsed = Number(raw.extra_usage.amount_used);
    const limit = Number(raw.extra_usage.limit);
    windows.push({
      key: "extra",
      label: "Extra Usage",
      durationMs: null,
      usageUnit: "currency",
      usedAmount: Number.isFinite(amountUsed) ? amountUsed : null,
      limitAmount: Number.isFinite(limit) ? limit : null,
      remainingAmount: Number.isFinite(amountUsed) && Number.isFinite(limit) ? Math.max(0, limit - amountUsed) : null,
      enabled: !!raw.extra_usage.is_enabled,
      exhausted: !!raw.extra_usage.is_enabled && Number.isFinite(amountUsed) && Number.isFinite(limit) ? amountUsed >= limit : false,
      resetAt: null,
    });
  }

  return {
    provider: "claude",
    source: "anthropic-oauth-usage-api",
    subscriptionType: raw.subscription_type || raw.subscriptionType || null,
    rateLimitTier: raw.rate_limit_tier || raw.rateLimitTier || null,
    windows,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

async function fetchClaudeOauthUsageAsync({ credentials, nowMs = Date.now(), timeoutMs = 8_000 }) {
  if (!hasUsableClaudeOauthToken(credentials, nowMs)) return null;
  const controller = new AbortController();
  const resolvedTimeoutMs = Math.max(1_000, Number(timeoutMs) || 8_000);
  const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  timeout.unref?.();
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${credentials.oauthToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Claude usage API returned ${res.status}${body ? `: ${body}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function cloneUsageSummary(summary) {
  return {
    ...summary,
    windows: Array.isArray(summary?.windows) ? summary.windows.map((window) => ({ ...window })) : [],
  };
}

function getCachedClaudeUsageSummary(configDir, nowMs, opts = {}) {
  const options = typeof opts === "boolean" ? { forceRefresh: opts } : (opts || {});
  const forceRefresh = !!options.forceRefresh;
  const ignoreBackoff = !!options.ignoreBackoff;
  if (
    !usageApiCache ||
    usageApiCache.configDir !== configDir ||
    !Array.isArray(usageApiCache.summary?.windows)
  ) {
    const diskCache = readClaudeUsageDiskCache(configDir);
    if (diskCache) usageApiCache = diskCache;
  }

  const cacheInBackoff =
    usageApiCache &&
    usageApiCache.configDir === configDir &&
    usageApiCache.nextRetryAt &&
    nowMs < usageApiCache.nextRetryAt;

  if (
    usageApiCache &&
    usageApiCache.configDir === configDir &&
    (
      (cacheInBackoff && !ignoreBackoff) ||
      (!forceRefresh && nowMs - usageApiCache.cachedAt <= claudeUsageCacheMs())
    )
  ) {
    return cloneUsageSummary(usageApiCache.summary);
  }

  return null;
}

function getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh = false) {
  if (
    !forceRefresh &&
    usageSummaryCache &&
    usageSummaryCache.configDir === configDir &&
    nowMs - usageSummaryCache.cachedAt <= claudeUsageCacheMs()
  ) {
    return {
      ...usageSummaryCache.summary,
      windows: summarizeClaudeUsageEntries(usageSummaryCache.entries, nowMs, limits),
    };
  }

  return null;
}

export async function refreshUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false, timeoutMs = 8_000 } = {}) {
  const configDir = getClaudeConfigDir();
  const limits = getClaudeUsageLimits();
  const credentials = readClaudeCredentials(configDir);
  if (!forceRefresh) {
    const settingsCached = buildClaudeUsageSummaryFromSettings(nowMs);
    if (settingsCached) return settingsCached;
  }
  const cached = getCachedClaudeUsageSummary(configDir, nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  if (hasUsableClaudeOauthToken(credentials, nowMs)) {
    const fetchImpl = globalThis.__posseFetchClaudeOauthUsageAsync || fetchClaudeOauthUsageAsync;
    try {
      const payload = await fetchImpl({ credentials, nowMs, timeoutMs });
      if (payload) {
        const summary = normalizeClaudeOauthUsageResponse(payload, nowMs, limits);
        enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs);
        if (!summary.subscriptionType) summary.subscriptionType = credentials.subscriptionType;
        if (!summary.rateLimitTier) summary.rateLimitTier = credentials.rateLimitTier;
        usageApiCache = {
          cachedAt: nowMs,
          configDir,
          summary,
          nextRetryAt: 0,
        };
        persistClaudeUsageSummaryToSettings(summary, nowMs);
        writeClaudeUsageDiskCache(configDir, usageApiCache);
        return cloneUsageSummary(summary);
      }
    } catch (err) {
      const message = String(err?.message || err || "");
      const rateLimited = /\b429\b|rate.?limit/i.test(message);
      const fallbackSummary = buildUsageFallbackSummary({ configDir, credentials, nowMs, rateLimited, message });
      enrichClaudeOauthSummaryWithLocalTokens(fallbackSummary, configDir, nowMs);

      usageApiCache = {
        cachedAt: nowMs,
        configDir,
        summary: fallbackSummary,
        nextRetryAt: nowMs + claudeUsageBackoffMs(),
      };
      writeClaudeUsageDiskCache(configDir, usageApiCache);

      if (!isDeprecatedClaudeLogUsageEnabled()) return cloneUsageSummary(fallbackSummary);
    }
  }

  if (!isDeprecatedClaudeLogUsageEnabled()) {
    return buildClaudeOauthUnavailableSummary(credentials, nowMs);
  }

  const cachedDeprecated = getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh);
  if (cachedDeprecated) return cachedDeprecated;

  const entries = loadClaudeUsageEntries(configDir, nowMs);
  const summary = {
    provider: "claude",
    source: "claude-local-project-logs-deprecated",
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: summarizeClaudeUsageEntries(entries, nowMs, limits),
    deprecatedFallbackAvailable: true,
    deprecatedFallbackEnabled: true,
  };

  usageSummaryCache = {
    cachedAt: nowMs,
    configDir,
    entries,
    summary: {
      provider: summary.provider,
      source: summary.source,
      subscriptionType: summary.subscriptionType,
      rateLimitTier: summary.rateLimitTier,
      deprecatedFallbackAvailable: true,
      deprecatedFallbackEnabled: true,
    },
  };

  return cloneUsageSummary(summary);
}

function buildUsageFallbackSummary({ configDir, credentials, nowMs, rateLimited, message }) {
  const staleSettingsSummary = buildClaudeUsageSummaryFromSettings(nowMs, { allowStale: true });
  return (
    usageApiCache &&
    usageApiCache.configDir === configDir &&
    Array.isArray(usageApiCache.summary?.windows) &&
    usageApiCache.summary.windows.length > 0
  )
    ? {
        ...usageApiCache.summary,
        stale: true,
        source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
        detail: message || null,
      }
    : (
      staleSettingsSummary &&
      Array.isArray(staleSettingsSummary.windows) &&
      staleSettingsSummary.windows.length > 0
    )
      ? {
          ...staleSettingsSummary,
          stale: true,
          source: rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
          detail: message || null,
        }
      : buildClaudeOauthUnavailableSummary(
          credentials,
          nowMs,
          rateLimited ? "anthropic-oauth-usage-api-rate-limited" : "anthropic-oauth-usage-api-unavailable",
          message || null
        );
}

function buildClaudeOauthUnavailableSummary(credentials, nowMs, source = null, detail = null) {
  return {
    provider: "claude",
    source: source || (hasUsableClaudeOauthToken(credentials, nowMs)
      ? "anthropic-oauth-usage-api-unavailable"
      : "anthropic-oauth-usage-api-unconfigured"),
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: [],
    detail: detail ? String(detail) : null,
  };
}

function loadClaudeUsageEntries(configDir, nowMs) {
  const projectsDir = path.join(configDir, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const weekWindow = CLAUDE_USAGE_WINDOW_DEFS.find((def) => def.key === "week")?.durationMs || (7 * 24 * 60 * 60 * 1000);
  const oldestRelevantMs = nowMs - weekWindow;
  const entryMap = new Map();
  const seenFiles = new Set();

  for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(projectsDir, projectEntry.name);

    for (const filePath of listClaudeUsageFiles(projectPath)) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      seenFiles.add(filePath);
      if (stat.mtimeMs < oldestRelevantMs) continue;

      const cached = usageFileCache.get(filePath);
      let fileEntries = null;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        fileEntries = cached.entries;
      } else {
        let raw;
        try {
          raw = fs.readFileSync(filePath, "utf8");
        } catch {
          continue;
        }

        const fileEntryMap = new Map();
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const usage = parsed?.message?.usage;
          const timestamp = parsed?.timestamp;
          if (!usage || !timestamp) continue;

          const timestampMs = Date.parse(timestamp);
          if (!Number.isFinite(timestampMs) || timestampMs < oldestRelevantMs) continue;

          const totalTokens =
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.output_tokens || 0);

          if (totalTokens <= 0) continue;

          const messageId = parsed?.message?.id || parsed?.requestId || parsed?.uuid || `${filePath}:${timestamp}`;
          const existing = fileEntryMap.get(messageId);
          if (!existing) {
            fileEntryMap.set(messageId, { messageId, timestampMs, totalTokens });
            continue;
          }

          if (totalTokens > existing.totalTokens) existing.totalTokens = totalTokens;
          if (timestampMs > existing.timestampMs) existing.timestampMs = timestampMs;
        }

        fileEntries = Array.from(fileEntryMap.values());
        usageFileCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: fileEntries,
        });
      }

      for (const entry of fileEntries) {
        if (!entry || entry.timestampMs < oldestRelevantMs) continue;
        const entryKey = `${filePath}:${entry.messageId || `${entry.timestampMs}:${entry.totalTokens}`}`;
        entryMap.set(entryKey, entry);
      }
    }
  }

  for (const filePath of Array.from(usageFileCache.keys())) {
    if (!seenFiles.has(filePath)) usageFileCache.delete(filePath);
  }

  return Array.from(entryMap.values());
}

export function getUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false } = {}) {
  const configDir = getClaudeConfigDir();
  const limits = getClaudeUsageLimits();
  const credentials = readClaudeCredentials(configDir);
  if (!forceRefresh) {
    const settingsCached = buildClaudeUsageSummaryFromSettings(nowMs);
    if (settingsCached) return settingsCached;
  }
  const cached = getCachedClaudeUsageSummary(configDir, nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  if (hasUsableClaudeOauthToken(credentials, nowMs)) {
    const fetchImpl = globalThis.__posseFetchClaudeOauthUsage;
    try {
      const payload = typeof fetchImpl === "function" ? fetchImpl({ credentials, nowMs }) : null;
      if (payload) {
        const summary = normalizeClaudeOauthUsageResponse(payload, nowMs, limits);
        enrichClaudeOauthSummaryWithLocalTokens(summary, configDir, nowMs);
        if (!summary.subscriptionType) summary.subscriptionType = credentials.subscriptionType;
        if (!summary.rateLimitTier) summary.rateLimitTier = credentials.rateLimitTier;
        usageApiCache = {
          cachedAt: nowMs,
          configDir,
          summary,
          nextRetryAt: 0,
        };
        persistClaudeUsageSummaryToSettings(summary, nowMs);
        writeClaudeUsageDiskCache(configDir, usageApiCache);
        return cloneUsageSummary(summary);
      }
    } catch (err) {
      const message = String(err?.message || err || "");
      const rateLimited = /\b429\b|rate.?limit/i.test(message);
      const fallbackSummary = buildUsageFallbackSummary({ configDir, credentials, nowMs, rateLimited, message });
      enrichClaudeOauthSummaryWithLocalTokens(fallbackSummary, configDir, nowMs);

      usageApiCache = {
        cachedAt: nowMs,
        configDir,
        summary: fallbackSummary,
        nextRetryAt: nowMs + claudeUsageBackoffMs(),
      };
      writeClaudeUsageDiskCache(configDir, usageApiCache);

      if (!isDeprecatedClaudeLogUsageEnabled()) {
        return cloneUsageSummary(fallbackSummary);
      }
    }
  }

  if (!isDeprecatedClaudeLogUsageEnabled()) {
    return buildClaudeOauthUnavailableSummary(credentials, nowMs);
  }

  const cachedDeprecated = getCachedDeprecatedClaudeUsageSummary(configDir, nowMs, limits, forceRefresh);
  if (cachedDeprecated) return cachedDeprecated;

  const entries = loadClaudeUsageEntries(configDir, nowMs);
  const summary = {
    provider: "claude",
    source: "claude-local-project-logs-deprecated",
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    windows: summarizeClaudeUsageEntries(entries, nowMs, limits),
    deprecatedFallbackAvailable: true,
    deprecatedFallbackEnabled: true,
  };

  usageSummaryCache = {
    cachedAt: nowMs,
    configDir,
    entries,
    summary: {
      provider: summary.provider,
      source: summary.source,
      subscriptionType: summary.subscriptionType,
      rateLimitTier: summary.rateLimitTier,
    },
  };

  return summary;
}
