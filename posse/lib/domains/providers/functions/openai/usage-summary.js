import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getAccountSetting } from "../../../settings/functions/account-settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { loadUsageEntries, summarizeUsageEntries } from "../shared/local-usage-summary.js";

const OPENAI_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session (5h)", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week (7d)", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

function readOpenAiLimitSetting(key) {
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

function getOpenAiUsageLimits() {
  return {
    session: readPositiveIntValue(getAccountSetting(SETTING_KEYS.OPENAI_ACCOUNT_LIMIT_TOKENS_SESSION))
      ?? readOpenAiLimitSetting("openai_limit_tokens_session"),
    week: readPositiveIntValue(getAccountSetting(SETTING_KEYS.OPENAI_ACCOUNT_LIMIT_TOKENS_WEEK))
      ?? readOpenAiLimitSetting("openai_limit_tokens_week"),
  };
}

function readPositiveIntValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = parseInt(String(value).trim(), 10);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
}

function readPercentValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = parseFloat(String(value).trim());
  return !Number.isNaN(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

function buildAccountSnapshotWindow(key, label) {
  const usedTokens = readPositiveIntValue(getAccountSetting(`openai_account_used_tokens_${key}`));
  const limitTokens = readPositiveIntValue(getAccountSetting(`openai_account_limit_tokens_${key}`));
  const observedPct = readPercentValue(getAccountSetting(`openai_account_observed_pct_${key}`));

  let resolvedUsed = usedTokens;
  let resolvedLimit = limitTokens;
  if (resolvedUsed == null && resolvedLimit != null && observedPct != null) {
    resolvedUsed = Math.round(resolvedLimit * (observedPct / 100));
  }
  if (resolvedLimit == null && resolvedUsed != null && observedPct != null) {
    resolvedLimit = Math.ceil(resolvedUsed / (observedPct / 100));
  }
  if (resolvedUsed == null && resolvedLimit == null && observedPct == null) return null;

  return {
    key,
    label,
    durationMs: null,
    usedTokens: resolvedUsed ?? 0,
    limitTokens: resolvedLimit ?? null,
    remainingTokens: resolvedLimit == null ? null : Math.max(0, resolvedLimit - (resolvedUsed ?? 0)),
    resetAt: null,
    observedPct,
    limitSource: resolvedLimit != null ? "account_snapshot" : null,
  };
}

function getOpenAiAccountUsageSummary() {
  const windows = [
    buildAccountSnapshotWindow("session", "Session (5h)"),
    buildAccountSnapshotWindow("week", "Week (7d)"),
  ].filter(Boolean);
  if (windows.length === 0) return null;
  return {
    provider: "openai",
    source: "account-snapshot",
    subscriptionType: null,
    rateLimitTier: null,
    windows,
  };
}

export function getUsageSummary({ nowMs = Date.now() } = {}) {
  const entries = loadUsageEntries({ nowMs, windowDefs: OPENAI_USAGE_WINDOW_DEFS, provider: "openai" });
  const localUsedTokens = entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0);
  const accountSummary = getOpenAiAccountUsageSummary();
  if (accountSummary) {
    return {
      ...accountSummary,
      localUsedTokens,
    };
  }
  return {
    provider: "openai",
    source: "posse-agent-calls",
    subscriptionType: null,
    rateLimitTier: null,
    localUsedTokens,
    windows: summarizeUsageEntries(entries, nowMs, getOpenAiUsageLimits(), OPENAI_USAGE_WINDOW_DEFS),
  };
}
