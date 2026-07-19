// lib/domains/providers/functions/codex/usage.js

import { spawn } from "child_process";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { assertTestContext } from "../../../runtime/functions/test-context.js";
import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { CodexUsageState } from "../../classes/codex/CodexUsageState.js";
import { InteractiveCliSession, InteractiveCliUnavailableError } from "../../classes/InteractiveCliSession.js";
import { buildWindowsSpawn, terminateSpawnedProcess } from "../shared/windows-spawn.js";
import { getDefaultInteractiveCliBackend, stripTerminalControls } from "../shared/interactive-cli-session.js";
import { loadUsageEntries, summarizeUsageEntries } from "../shared/local-usage-summary.js";
import { ensureCodexResolvedAsync, getCodexLaunchState } from "./cli-discovery.js";
import { readPositiveMsSetting } from "./settings.js";

const CODEX_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session (5h)", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week (7d)", durationMs: 7 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_CODEX_USAGE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_CODEX_USAGE_BACKOFF_MS = 5 * 60 * 1000;

function codexUsageCacheMs() {
  return readPositiveMsSetting(SETTING_KEYS.CODEX_USAGE_CACHE_MS, DEFAULT_CODEX_USAGE_CACHE_MS);
}

function codexUsageBackoffMs() {
  return readPositiveMsSetting(SETTING_KEYS.CODEX_USAGE_BACKOFF_MS, DEFAULT_CODEX_USAGE_BACKOFF_MS);
}

function readCodexLimitSetting(key) {
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

function getCodexUsageLimits() {
  return {
    session: readCodexLimitSetting("codex_limit_tokens_session"),
    week: readCodexLimitSetting("codex_limit_tokens_week"),
  };
}

function buildCodexLocalUsageSummary(nowMs = Date.now(), detail = null) {
  const entries = loadUsageEntries({
    nowMs,
    windowDefs: CODEX_USAGE_WINDOW_DEFS,
    provider: "codex",
    normalizeProvider: true,
  });
  const localUsedTokens = entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0);
  return {
    provider: "codex",
    source: "posse-agent-calls",
    subscriptionType: null,
    rateLimitTier: null,
    localUsedTokens,
    windows: summarizeUsageEntries(entries, nowMs, getCodexUsageLimits(), CODEX_USAGE_WINDOW_DEFS),
    detail: detail ? String(detail) : null,
  };
}

function cloneUsageSummary(summary) {
  return {
    ...summary,
    windows: Array.isArray(summary?.windows) ? summary.windows.map((window) => ({ ...window })) : [],
    credits: summary?.credits && typeof summary.credits === "object" ? { ...summary.credits } : summary?.credits,
  };
}

const codexUsageState = new CodexUsageState({
  cacheMs: codexUsageCacheMs,
  backoffMs: codexUsageBackoffMs,
  cloneUsageSummary,
});

function clampPercent(value) {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

const CODEX_STATUS_MONTHS = new Map([
  ["jan", 0], ["january", 0],
  ["feb", 1], ["february", 1],
  ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3],
  ["may", 4],
  ["jun", 5], ["june", 5],
  ["jul", 6], ["july", 6],
  ["aug", 7], ["august", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["october", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["december", 11],
]);

function parseCodexStatusResetAt(fragment, nowMs = Date.now()) {
  const text = String(fragment || "").trim().replace(/^resets\s+/i, "");
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]+))?/i);
  if (!match) return null;
  const now = new Date(nowMs);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute > 59) return null;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (match[3] && match[4]) {
    const month = CODEX_STATUS_MONTHS.get(match[4].toLowerCase());
    const day = Number(match[3]);
    if (month == null || !Number.isInteger(day) || day < 1 || day > 31) return null;
    candidate.setMonth(month, day);
    if (candidate.getTime() < nowMs - 24 * 60 * 60 * 1000) {
      candidate.setFullYear(candidate.getFullYear() + 1);
    }
  } else if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate.toISOString();
}

function normalizeCodexLimitKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseCodexStatusText(text, nowMs = Date.now()) {
  const clean = stripTerminalControls(text);
  const parsed = {
    account: null,
    accountPlan: null,
    sessionId: null,
    credits: null,
    windows: [],
  };
  let sectionName = null;

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line) continue;

    const accountMatch = line.match(/^Account:\s*(.+?)(?:\s+\(([^)]+)\))?$/i);
    if (accountMatch) {
      parsed.account = accountMatch[1].trim() || null;
      parsed.accountPlan = accountMatch[2]?.trim() || null;
      sectionName = null;
      continue;
    }

    const sessionMatch = line.match(/^Session:\s*(.+)$/i);
    if (sessionMatch) {
      parsed.sessionId = sessionMatch[1].trim() || null;
      continue;
    }

    const creditsMatch = line.match(/^Credits:\s*([0-9][0-9,]*(?:\.\d+)?)\s*credits?/i);
    if (creditsMatch) {
      parsed.credits = {
        hasCredits: true,
        unlimited: false,
        balance: Number(creditsMatch[1].replace(/,/g, "")),
      };
      continue;
    }

    if (/^Credits:\s*unlimited/i.test(line)) {
      parsed.credits = {
        hasCredits: true,
        unlimited: true,
        balance: null,
      };
      continue;
    }

    const sectionMatch = line.match(/^(.+?)\s+limit:\s*$/i);
    if (sectionMatch && !/^(?:5h|weekly)\s+limit/i.test(line)) {
      sectionName = sectionMatch[1].trim();
      continue;
    }

    const windowMatch = line.match(/^(5h|Weekly)\s+limit:\s*(?:\[[^\]]*\]\s*)?([0-9]+(?:\.[0-9]+)?)%\s+left(?:\s*\(([^)]*)\))?/i);
    if (!windowMatch) continue;

    const baseKey = /^5h$/i.test(windowMatch[1]) ? "session" : "week";
    const remainingPct = clampPercent(windowMatch[2]);
    if (remainingPct == null) continue;
    const sectionKey = normalizeCodexLimitKey(sectionName || "codex");
    const isDefaultSection = !sectionName || sectionKey === "codex";
    const key = isDefaultSection ? baseKey : `${sectionKey}_${baseKey}`;
    const labelPrefix = isDefaultSection ? "" : `${sectionName} `;
    parsed.windows.push({
      key,
      label: `${labelPrefix}${baseKey === "session" ? "Session (5h)" : "Week (7d)"}`,
      durationMs: baseKey === "session" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
      utilizationPct: Math.max(0, 100 - remainingPct),
      usageUnit: "percent",
      usedTokens: null,
      limitTokens: null,
      remainingTokens: null,
      remainingPct,
      exhausted: remainingPct <= 0,
      resetAt: parseCodexStatusResetAt(windowMatch[3], nowMs),
      limitId: isDefaultSection ? "codex" : sectionName,
    });
  }

  return parsed;
}

function normalizeCodexStatusSummary(parsed, nowMs = Date.now()) {
  const local = buildCodexLocalUsageSummary(nowMs);
  const windows = Array.isArray(parsed?.windows) ? parsed.windows.map((window) => ({ ...window })) : [];
  if (windows.some((window) => window.key === "week") && !windows.some((window) => window.key === "session")) {
    windows.unshift(buildUnlimitedCodexSessionWindow());
  }
  return {
    provider: "codex",
    source: "codex-cli-status",
    subscriptionType: parsed?.accountPlan || null,
    rateLimitTier: null,
    account: parsed?.account || null,
    sessionId: parsed?.sessionId || null,
    credits: parsed?.credits || null,
    localUsedTokens: local.localUsedTokens || 0,
    windows,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function readRateLimitField(obj, camelKey, snakeKey = null) {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[camelKey] !== undefined) return obj[camelKey];
  if (snakeKey && obj[snakeKey] !== undefined) return obj[snakeKey];
  return undefined;
}

function formatCodexWindowLabel(baseKey, durationMins, limitLabel = null) {
  const prefix = limitLabel ? `${limitLabel} ` : "";
  if (baseKey === "session") {
    if (durationMins === 300) return `${prefix}Session (5h)`;
    if (durationMins === 60) return `${prefix}Session (1h)`;
    if (Number.isFinite(durationMins) && durationMins > 0) return `${prefix}Session (${durationMins}m)`;
    return `${prefix}Session`;
  }
  if (durationMins === 10080) return `${prefix}Week (7d)`;
  if (durationMins === 1440) return `${prefix}Week (1d)`;
  if (Number.isFinite(durationMins) && durationMins > 0) return `${prefix}Week (${durationMins}m)`;
  return `${prefix}Week`;
}

const CODEX_WINDOW_IDENTITY_FIELDS = [
  ["windowKind", "window_kind"],
  ["windowType", "window_type"],
  ["windowId", "window_id"],
  ["kind", null],
  ["type", null],
  ["id", null],
  ["name", null],
  ["label", null],
];

function classifyCodexWindowIdentity(rawWindow) {
  for (const [camelKey, snakeKey] of CODEX_WINDOW_IDENTITY_FIELDS) {
    const rawValue = readRateLimitField(rawWindow, camelKey, snakeKey);
    if (rawValue == null || String(rawValue).trim() === "") continue;
    const label = String(rawValue).trim().slice(0, 80);
    const normalized = normalizeCodexLimitKey(label);
    if (!normalized || normalized === "primary" || normalized === "secondary") continue;
    if (/^(?:session|5h|5-hour|five-hour|five-hours)$/.test(normalized)) {
      return { kind: "session", label, explicit: true };
    }
    if (/^(?:week|weekly|7d|7-day|seven-day|seven-days)$/.test(normalized)) {
      return { kind: "week", label, explicit: true };
    }
    return { kind: "provider-specific", label, explicit: true };
  }
  return { kind: null, label: null, explicit: false };
}

function classifyCodexWindow(rawWindow, position) {
  const identity = classifyCodexWindowIdentity(rawWindow);
  const durationRaw = readRateLimitField(rawWindow, "windowDurationMins", "window_duration_mins");
  const durationMins = Number(durationRaw);
  const hasUsableDuration = Number.isFinite(durationMins) && durationMins > 0;
  if (identity.kind) {
    return { ...identity, durationMins: hasUsableDuration ? durationMins : null };
  }
  if (hasUsableDuration) {
    if (durationMins === 300) return { kind: "session", label: null, explicit: true, durationMins };
    if (durationMins === 10_080) return { kind: "week", label: null, explicit: true, durationMins };
    return { kind: "provider-specific", label: null, explicit: true, durationMins };
  }
  return {
    kind: position === "secondary" ? "week" : "session",
    label: null,
    explicit: false,
    durationMins: null,
  };
}

function buildUnlimitedCodexSessionWindow() {
  return {
    key: "session",
    label: "Session",
    durationMs: null,
    utilizationPct: null,
    usageUnit: "unlimited",
    usedTokens: null,
    limitTokens: null,
    remainingTokens: null,
    remainingPct: null,
    exhausted: false,
    resetAt: null,
    limitId: "codex",
    unlimited: true,
  };
}

function providerSpecificCodexWindowKey({ keyPrefix, position, identityLabel, durationMins }) {
  const identityKey = normalizeCodexLimitKey(identityLabel || "")
    || (Number.isFinite(durationMins) ? `${durationMins}m` : "window");
  return `${keyPrefix || "provider_"}${position}_${identityKey}`;
}

function formatProviderSpecificCodexWindowLabel({ limitLabel, identityLabel, durationMins }) {
  const prefix = limitLabel ? `${limitLabel} ` : "";
  const identity = identityLabel || "Provider window";
  const duration = Number.isFinite(durationMins) && durationMins > 0
    ? ` (${durationMins}m)`
    : "";
  return `${prefix}${identity}${duration}`;
}

function normalizeCodexRateLimitWindow(rawWindow, {
  position,
  keyPrefix = "",
  limitId = "codex",
  limitLabel = null,
} = {}) {
  if (!rawWindow || typeof rawWindow !== "object") return null;
  const classification = classifyCodexWindow(rawWindow, position);
  const usedPct = clampPercent(readRateLimitField(rawWindow, "usedPercent", "used_percent"));
  if (usedPct == null) return null;
  const { durationMins } = classification;
  const resetSeconds = readRateLimitField(rawWindow, "resetsAt", "resets_at");
  const baseKey = classification.kind;
  const key = baseKey === "session" || baseKey === "week"
    ? `${keyPrefix}${baseKey}`
    : providerSpecificCodexWindowKey({
        keyPrefix,
        position,
        identityLabel: classification.label,
        durationMins,
      });
  const label = baseKey === "session" || baseKey === "week"
    ? formatCodexWindowLabel(baseKey, durationMins, limitLabel)
    : formatProviderSpecificCodexWindowLabel({
        limitLabel,
        identityLabel: classification.label,
        durationMins,
      });
  return {
    key,
    label,
    durationMs: Number.isFinite(durationMins) && durationMins > 0 ? durationMins * 60 * 1000 : null,
    utilizationPct: usedPct,
    usageUnit: "percent",
    usedTokens: null,
    limitTokens: null,
    remainingTokens: null,
    remainingPct: Math.max(0, 100 - usedPct),
    exhausted: usedPct >= 100,
    resetAt: unixSecondsToIso(resetSeconds),
    limitId,
    unlimited: false,
    identityExplicit: classification.explicit,
  };
}

function normalizeCodexCredits(rawCredits) {
  if (!rawCredits || typeof rawCredits !== "object") return null;
  const hasCredits = readRateLimitField(rawCredits, "hasCredits", "has_credits");
  const unlimited = readRateLimitField(rawCredits, "unlimited");
  const balance = readRateLimitField(rawCredits, "balance");
  return {
    hasCredits: hasCredits == null ? null : !!hasCredits,
    unlimited: unlimited == null ? null : !!unlimited,
    balance: balance == null || balance === "" ? null : Number(balance),
  };
}

function normalizeCodexRateLimitSnapshot(snapshot, {
  baseKeyPrefix = "",
  limitLabel = null,
  canonicalLimit = false,
} = {}) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const limitId = String(
    readRateLimitField(snapshot, "limitId", "limit_id")
      || readRateLimitField(snapshot, "limitName", "limit_name")
      || limitLabel
      || "codex"
  );
  const keyPrefix = baseKeyPrefix ? `${normalizeCodexLimitKey(baseKeyPrefix)}_` : "";
  const primary = readRateLimitField(snapshot, "primary");
  const secondary = readRateLimitField(snapshot, "secondary");
  const rawWindows = [
    { position: "primary", rawWindow: primary },
    { position: "secondary", rawWindow: secondary },
  ];
  const classified = rawWindows.map(({ position, rawWindow }) => ({
    position,
    rawWindow,
    classification: rawWindow && typeof rawWindow === "object"
      ? classifyCodexWindow(rawWindow, position)
      : null,
  }));
  const windows = [
    normalizeCodexRateLimitWindow(primary, {
      position: "primary",
      keyPrefix,
      limitId,
      limitLabel,
    }),
    normalizeCodexRateLimitWindow(secondary, {
      position: "secondary",
      keyPrefix,
      limitId,
      limitLabel,
    }),
  ].filter(Boolean);
  const hasExplicitWeekly = classified.some((entry) =>
    entry.classification?.explicit && entry.classification.kind === "week"
  );
  const hasSessionSignal = classified.some((entry) => entry.classification?.kind === "session");
  if (canonicalLimit && hasExplicitWeekly && !hasSessionSignal && !windows.some((window) => window.key === "session")) {
    windows.unshift(buildUnlimitedCodexSessionWindow());
  }
  return windows;
}

function normalizeCodexRateLimitsResponse(payload, nowMs = Date.now()) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const primarySnapshot = readRateLimitField(raw, "rateLimits", "rate_limits") || {};
  const byLimitId = readRateLimitField(raw, "rateLimitsByLimitId", "rate_limits_by_limit_id") || {};
  const rawPrimaryLimitId = readRateLimitField(primarySnapshot, "limitId", "limit_id");
  const primaryLimitId = String(rawPrimaryLimitId || "codex");
  const normalizedPrimaryLimitId = normalizeCodexLimitKey(primaryLimitId);
  const canonicalLimit = rawPrimaryLimitId == null
    || normalizedPrimaryLimitId === "codex"
    || normalizedPrimaryLimitId === "default";
  const primaryLimitName = readRateLimitField(primarySnapshot, "limitName", "limit_name");
  const windows = normalizeCodexRateLimitSnapshot(primarySnapshot, canonicalLimit
    ? { canonicalLimit: true }
    : {
        baseKeyPrefix: primaryLimitId,
        limitLabel: String(primaryLimitName || primaryLimitId),
        canonicalLimit: false,
      });

  if (byLimitId && typeof byLimitId === "object") {
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const snapshotLimitId = String(readRateLimitField(snapshot, "limitId", "limit_id") || limitId || "");
      if (snapshotLimitId === primaryLimitId || (snapshotLimitId === "codex" && primaryLimitId === "codex")) continue;
      const limitName = String(readRateLimitField(snapshot, "limitName", "limit_name") || snapshotLimitId || limitId);
      windows.push(...normalizeCodexRateLimitSnapshot(snapshot, {
        baseKeyPrefix: snapshotLimitId || limitId,
        limitLabel: limitName,
      }));
    }
  }

  const credits = normalizeCodexCredits(readRateLimitField(primarySnapshot, "credits"));
  const local = buildCodexLocalUsageSummary(nowMs);
  return {
    provider: "codex",
    source: "codex-app-server-rate-limits",
    subscriptionType: readRateLimitField(primarySnapshot, "planType", "plan_type") || null,
    rateLimitTier: null,
    credits,
    rateLimitReachedType: readRateLimitField(primarySnapshot, "rateLimitReachedType", "rate_limit_reached_type") || null,
    localUsedTokens: local.localUsedTokens || 0,
    windows,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

async function fetchCodexStatusViaInteractive({
  cwd = null,
  timeoutMs = 8_000,
  backend = null,
} = {}) {
  await ensureCodexResolvedAsync();
  const { cmd: codexCmd, args: codexArgs, error: codexResolveError } = getCodexLaunchState();
  if (!codexCmd) throw new Error(codexResolveError || "Codex CLI not found");
  const resolvedBackend = backend || getDefaultInteractiveCliBackend();
  if (!resolvedBackend) throw new InteractiveCliUnavailableError();

  const args = [
    ...codexArgs,
    "--no-alt-screen",
    "--ask-for-approval", "never",
    "--sandbox", "read-only",
  ];
  if (cwd) args.push("--cd", cwd);
  const launch = buildWindowsSpawn(codexCmd, args);
  const session = new InteractiveCliSession({
    command: launch.command,
    args: launch.args,
    cwd: cwd || process.cwd(),
    env: process.env,
    backend: resolvedBackend,
    timeoutMs,
    quietMs: 500,
    cols: 120,
    rows: 40,
  });

  try {
    session.start();
    await session.waitForQuiet({ quietMs: 300, timeoutMs: Math.min(timeoutMs, 2_000) }).catch(() => {});
    session.sendLine("/status");
    await session.waitFor(
      (output) => /(?:5h|Weekly)\s+limit:|Credits:/i.test(stripTerminalControls(output)),
      { timeoutMs }
    );
    await session.waitForQuiet({ quietMs: 600, timeoutMs: Math.min(timeoutMs, 3_000) }).catch(() => {});
    session.sendLine("/quit");
    return session.cleanTranscript();
  } finally {
    await session.close({ gracefulMs: 500 });
  }
}

async function fetchCodexRateLimitsViaAppServer({
  cwd = null,
  timeoutMs = 8_000,
} = {}) {
  await ensureCodexResolvedAsync();
  const { cmd: codexCmd, args: codexArgs, error: codexResolveError } = getCodexLaunchState();
  if (!codexCmd) throw new Error(codexResolveError || "Codex CLI not found");
  const launch = buildWindowsSpawn(codexCmd, [...codexArgs, "app-server", "--listen", "stdio://"]);
  const resolvedTimeoutMs = Math.max(1_000, Number(timeoutMs) || 8_000);

  return await new Promise((resolve, reject) => {
    let proc;
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let nextId = 1;
    let initializeId = null;
    let rateLimitsId = null;

    const finish = (err, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc) terminateSpawnedProcess(proc, { force: process.platform === "win32" });
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Codex app-server rate-limit request timed out after ${resolvedTimeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`));
    }, resolvedTimeoutMs);
    timer.unref?.();

    const writeMessage = (message) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const sendRequest = (method, params = undefined) => {
      const id = nextId++;
      const message = { id, method };
      if (params !== undefined) message.params = params;
      writeMessage(message);
      return id;
    };

    const handleMessage = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.id === initializeId) {
        if (message.error) {
          finish(new Error(`Codex app-server initialize failed: ${message.error?.message || JSON.stringify(message.error)}`));
          return;
        }
        writeMessage({ method: "notifications/initialized" });
        rateLimitsId = sendRequest("account/rateLimits/read");
        return;
      }

      if (message.id === rateLimitsId) {
        if (message.error) {
          finish(new Error(`Codex app-server rate-limit read failed: ${message.error?.message || JSON.stringify(message.error)}`));
          return;
        }
        finish(null, message.result || {});
      }
    };

    try {
      proc = spawn(launch.command, launch.args, {
        cwd: cwd || process.cwd(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (err) {
      finish(err);
      return;
    }

    proc.stdin.on("error", () => {});
    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // Ignore non-JSON startup noise; stderr is retained for failures.
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr = appendBoundedText(stderr, chunk);
    });
    proc.on("error", (err) => finish(err));
    proc.on("close", (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before rate-limit response (exit ${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    initializeId = sendRequest("initialize", {
      clientInfo: {
        name: "posse",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });
}

export async function refreshUsageSummary({
  nowMs = Date.now(),
  forceRefresh = false,
  ignoreBackoff = false,
  timeoutMs = 8_000,
  cwd = null,
  interactiveBackend = null,
  preferInteractive = false,
  allowInteractiveOnWindows = false,
  platform = process.platform,
} = {}) {
  const cached = codexUsageState.getCachedSummary(nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;

  const errors = [];
  const interactiveSkipReason = preferInteractive
    ? codexUsageState.shouldSkipInteractiveUsage({ allowInteractiveOnWindows, platform })
    : null;
  if (preferInteractive && !interactiveSkipReason) {
    try {
      const { interactive: fetchInteractive } = codexUsageState.getFetchers({
        interactive: fetchCodexStatusViaInteractive,
        appServer: fetchCodexRateLimitsViaAppServer,
      });
      const needsBackend = fetchInteractive === fetchCodexStatusViaInteractive;
      const backend = interactiveBackend || (needsBackend ? getDefaultInteractiveCliBackend() : null);
      if (needsBackend && !backend) throw new InteractiveCliUnavailableError();
      const transcript = await fetchInteractive({ cwd, timeoutMs, backend });
      const summary = normalizeCodexStatusSummary(parseCodexStatusText(transcript, nowMs), nowMs);
      return codexUsageState.storeSummary(summary, nowMs);
    } catch (err) {
      codexUsageState.markInteractiveUsageUnavailable(err);
      errors.push(err);
    }
  } else if (preferInteractive && interactiveSkipReason) {
    errors.push(new InteractiveCliUnavailableError(`Codex interactive usage probe disabled: ${interactiveSkipReason}`));
  }

  try {
    const { appServer: fetchAppServer } = codexUsageState.getFetchers({
      interactive: fetchCodexStatusViaInteractive,
      appServer: fetchCodexRateLimitsViaAppServer,
    });
    const payload = await fetchAppServer({ cwd, timeoutMs });
    const summary = normalizeCodexRateLimitsResponse(payload, nowMs);
    return codexUsageState.storeSummary(summary, nowMs);
  } catch (err) {
    errors.push(err);
  }

  const staleBase = codexUsageState.currentSummary();
  const stale = staleBase
    ? {
        ...staleBase,
        stale: true,
        source: "codex-rate-limits-unavailable",
        detail: errors.map((err) => String(err?.message || err)).filter(Boolean).join("; ") || null,
      }
    : {
        ...buildCodexLocalUsageSummary(nowMs, errors.map((err) => String(err?.message || err)).filter(Boolean).join("; ") || null),
        source: "codex-rate-limits-unavailable",
      };
  return codexUsageState.storeUnavailableSummary(stale, nowMs);
}

export function getUsageSummary({ nowMs = Date.now(), forceRefresh = false, ignoreBackoff = false } = {}) {
  const cached = codexUsageState.getCachedSummary(nowMs, { forceRefresh, ignoreBackoff });
  if (cached) return cached;
  return buildCodexLocalUsageSummary(nowMs);
}

export const __testParseCodexStatusText = parseCodexStatusText;
export const __testNormalizeCodexStatusSummary = normalizeCodexStatusSummary;
export const __testNormalizeCodexRateLimitsResponse = normalizeCodexRateLimitsResponse;
export const __testFetchCodexStatusViaInteractive = fetchCodexStatusViaInteractive;
export const __testFetchCodexRateLimitsViaAppServer = fetchCodexRateLimitsViaAppServer;
export const __testBuildCodexLocalUsageSummary = buildCodexLocalUsageSummary;

export function __testSetCodexUsageFetchers({ interactive = null, appServer = null } = {}) {
  assertTestContext("__testSetCodexUsageFetchers");
  codexUsageState.setFetchers({ interactive, appServer });
}

export function __testResetCodexUsageState() {
  assertTestContext("__testResetCodexUsageState");
  codexUsageState.reset();
}

export function __testGetCodexInteractiveUsageUnavailableReason() {
  return codexUsageState.interactiveUsageUnavailableReason;
}
