// @ts-check
//
// Shared admin-UI helpers — display/parse/format utilities that were
// byte-for-byte duplicated between AdminTUI and settings-controller. Pure
// (and best-effort report/DB reads); no class state. The diverged helpers
// (safeGetSetting / setSettingWithRuntimeSync and the four that call them,
// plus getHistoryJobPresentation) intentionally stay in each class file.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { getRuntimeDbPath, getRuntimeReportsDir } from "../../../runtime/functions/paths.js";
import { getProviderTierDefaults } from "../../../providers/functions/model-catalog.js";
import { fit as fitAnsi, stripAnsi } from "../../../../shared/format/functions/ansi.js";
import { formatRelativeTime as fmtRelativeTime, formatTokens as fmtTokens } from "../../../../shared/format/functions/units.js";
import {
  getAdminSettingPresentation,
  NUMERIC_SETTING_RULES,
  toDisplaySettingKey,
  toStorageSettingKey,
} from "../../../settings/functions/admin-catalog.js";

export function toDisplaySettingEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const storageKey = entry.storage_key || entry.setting_key;
  const displayKey = toDisplaySettingKey(storageKey);
  const presentation = getAdminSettingPresentation(displayKey, entry);
  return {
    ...entry,
    setting_key: displayKey,
    storage_key: storageKey,
    ...presentation,
  };
}

export function normalizeRawInput(chunk) {
  const str = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  switch (str) {
    case "\u0003":
      return { str: "", key: { ctrl: true, name: "c" } };
    case "\u001b":
      return { str: "", key: { name: "escape" } };
    case "\t":
      return { str: "", key: { name: "tab", sequence: "\t" } };
    case "\r":
    case "\n":
      return { str, key: { name: "enter", sequence: str } };
    case "\u001b[A":
      return { str: "", key: { name: "up" } };
    case "\u001b[B":
      return { str: "", key: { name: "down" } };
    case "\u001b[C":
      return { str: "", key: { name: "right" } };
    case "\u001b[D":
      return { str: "", key: { name: "left" } };
    case "\u007f":
    case "\b":
      return { str, key: { name: "backspace", sequence: str } };
    default:
      if (str.length === 1) return { str, key: { name: str.toLowerCase(), sequence: str } };
      return { str, key: { sequence: str } };
  }
}

export function fit(str, width) {
  return fitAnsi(str, width, { reset: C.reset });
}

export function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseJsonObject(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function fmtDate(iso) {
  if (!iso) return "?";
  return iso.replace("T", " ").slice(0, 16);
}

export function isEnterKey(str, key) {
  if (str === "\r" || str === "\n") return true;
  return !!key && (key.name === "return" || key.name === "enter");
}

export function isBackspaceKey(str, key) {
  if (str === "\b" || str === "\x7f") return true;
  return !!key && key.name === "backspace";
}

export function getPrintableInput(str, key) {
  if (typeof str === "string" && /^[ -~]$/.test(str)) return str;
  if (typeof key?.sequence === "string" && /^[ -~]$/.test(key.sequence)) return key.sequence;
  return "";
}

export function matchesHotkey(str, key, expected) {
  if (typeof str === "string" && str.toLowerCase() === expected) return true;
  if (typeof key?.name === "string" && key.name.toLowerCase() === expected) return true;
  return false;
}

export function isBooleanSettingValue(value) {
  return value === "true" || value === "false";
}

export function clipPlainTail(str, width) {
  if (width <= 0) return "";
  const raw = String(str ?? "");
  if (raw.length <= width) return raw;
  if (width === 1) return "\u2026";
  return `\u2026${raw.slice(-(width - 1))}`;
}

export function visibleLength(str) {
  return stripAnsi(String(str ?? "")).length;
}

export function parseProviderList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((provider, index, arr) => arr.indexOf(provider) === index);
}

export function formatProviderSettingValue(entry) {
  if (!entry) return "";
  if (entry.source !== "env") return entry.setting_value || "";
  const dbValue = entry.db_value ? ` db:${entry.db_value}` : " db:(none)";
  return `${entry.setting_value || ""}${dbValue}`;
}

export function getModelProviderDefaults(provider) {
  return getProviderTierDefaults(provider);
}

export function formatModelSettingDisplayValue(entry) {
  if (!entry) return "";
  if (entry.setting_value) return `${entry.setting_value}`;
  if (entry.effective_model) return `${entry.effective_model}`;
  return "";
}

export function formatProviderUsageHeader(summary) {
  const meta = [summary.subscriptionType, summary.rateLimitTier].filter(Boolean).join(" / ");
  return meta ? `${summary.provider} ${C.dim}(${meta})${C.reset}` : summary.provider;
}

export function renderUsageBar(usedTokens, limitTokens, width = 18) {
  const safeWidth = Math.max(8, width | 0);
  if (!(limitTokens > 0)) return `${C.dim}[${"?".repeat(safeWidth)}]${C.reset}`;
  const ratio = Math.max(0, Math.min(1, usedTokens / limitTokens));
  const filled = Math.max(0, Math.min(safeWidth, Math.round(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  const barColor = ratio >= 0.9 ? C.red : ratio >= 0.75 ? C.yellow : C.green;
  return `${C.dim}[${C.reset}${barColor}${"#".repeat(filled)}${C.dim}${".".repeat(empty)}${C.reset}${C.dim}]${C.reset}`;
}

export function formatProviderUsageWindow(window) {
  const parts = [`${window.label}:`];
  if (window.limitTokens != null) {
    parts.push(renderUsageBar(window.usedTokens, window.limitTokens));
    parts.push(`${fmtTokens(window.usedTokens)} used`);
    parts.push(`of ${fmtTokens(window.limitTokens)}`);
    parts.push(`${fmtTokens(window.remainingTokens)} remaining`);
    if (window.limitSource === "inferred_percent" && window.observedPct != null) {
      parts.push(`${C.dim}inferred from ${window.observedPct}%${C.reset}`);
    }
  } else {
    parts.push(renderUsageBar(0, null));
    parts.push(`${fmtTokens(window.usedTokens)} used`);
    parts.push(`${C.dim}remaining unavailable${C.reset}`);
  }
  if (window.resetAt) {
    parts.push(`${C.dim}next drop ${fmtRelativeTime(window.resetAt)}${C.reset}`);
  }
  return parts.join(`  ${C.dim}|${C.reset}  `);
}

export function parseProviderUsageSettingKey(settingKey) {
  const match = String(settingKey || "").match(/^([a-z0-9]+)_(limit_tokens|observed_pct)_(session|week)$/i);
  if (!match) return null;
  return { provider: match[1].toLowerCase(), kind: match[2].toLowerCase(), windowKey: match[3].toLowerCase() };
}

export function correspondingLimitSettingKey(settingKey) {
  const parsed = parseProviderUsageSettingKey(settingKey);
  if (!parsed) return null;
  return `${parsed.provider}_limit_tokens_${parsed.windowKey}`;
}

export function normalizeNumericSettingValue(settingKey, value) {
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
  if (numberValue < rule.min) {
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

export function buildProviderUsageWindowMap(summaries = []) {
  const map = new Map();
  for (const summary of summaries || []) {
    for (const window of summary.windows || []) {
      map.set(`${summary.provider}:${window.key}`, window);
    }
  }
  return map;
}

export function getProviderUsageSettingHint(settingKey, usageWindowMap) {
  const parsed = parseProviderUsageSettingKey(settingKey);
  if (!parsed) return "";
  const window = usageWindowMap.get(`${parsed.provider}:${parsed.windowKey}`);
  if (!window) return "";

  if (parsed.kind === "observed_pct") {
    if (window.limitTokens != null) return `live: ${fmtTokens(window.limitTokens)} cap configured`;
    return window.usedTokens > 0 ? `live: ${fmtTokens(window.usedTokens)} used so far` : "live: waiting for usage";
  }

  if (parsed.kind === "limit_tokens" && window.limitTokens != null) {
    const sourceTag = window.limitSource === "inferred_percent" ? "~" : "";
    return `live: ${fmtTokens(window.usedTokens)} used, ${sourceTag}${fmtTokens(window.remainingTokens || 0)} remaining`;
  }

  return window.usedTokens > 0 ? `live: ${fmtTokens(window.usedTokens)} used so far` : "";
}

export function runtimeDbLooksBusyOrCorrupt() {
  try {
    const dbPath = getRuntimeDbPath();
    if (!fs.existsSync(dbPath)) return false;
    const stat = fs.statSync(dbPath);
    return stat.size === 0 && fs.existsSync(`${dbPath}-journal`);
  } catch {
    return true;
  }
}

export function parseReportTimestamp(file) {
  return file.replace("report-", "").replace(".json", "").replace(/-/g, (m, offset) => {
    return offset === 4 || offset === 7 ? "-" : offset === 10 ? " " : offset === 13 || offset === 16 ? ":" : m;
  });
}

export function loadReportIndex(projectDir) {
  const reportsDir = getRuntimeReportsDir(projectDir);
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter(f => f.endsWith(".json") && f.startsWith("report-"))
    .sort()
    .reverse()
    .map((file) => {
      const filePath = path.join(reportsDir, file);
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(filePath).size; } catch { /* ignore */ }
      return { file, filePath, timestamp: parseReportTimestamp(file), sizeBytes, data: null };
    });
}

export function loadIndexedReport(report) {
  if (Array.isArray(report?.data)) return report;
  try {
    const raw = fs.readFileSync(report.filePath, "utf-8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : [data];
    const valid = items.length > 0 && items.every(d =>
      d.workItem && typeof d.workItem.id !== "undefined" &&
      Array.isArray(d.jobs) && d.totals && typeof d.totals === "object"
    );
    if (!valid) return { ...report, data: [], loadError: "Incompatible report schema" };
    return { ...report, data: items, loadError: null };
  } catch (err) {
    return { ...report, data: [], loadError: err.message || "Could not load report" };
  }
}

export function loadReports(projectDir) {
  const dbPath = getRuntimeDbPath(projectDir);
  const reportsDir = getRuntimeReportsDir(projectDir);
  if (!fs.existsSync(reportsDir)) return [];

  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith(".json") && f.startsWith("report-"))
    .sort()
    .reverse(); // newest first

  const reports = [];
  for (const file of files) {
    const filePath = path.join(reportsDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];

      // Validate: every item must have workItem with an id, and jobs/totals arrays/objects
      const valid = items.length > 0 && items.every(d =>
        d.workItem && typeof d.workItem.id !== "undefined" &&
        Array.isArray(d.jobs) && d.totals && typeof d.totals === "object"
      );
      if (!valid) {
        // Incompatible with current schema — skip (don't delete historical data)
        continue;
      }

      const timestamp = file.replace("report-", "").replace(".json", "").replace(/-/g, (m, offset) => {
        // Convert report-YYYY-MM-DDTHH-MM-SS back to readable format
        return offset === 4 || offset === 7 ? "-" : offset === 10 ? " " : offset === 13 || offset === 16 ? ":" : m;
      });
      reports.push({ file, timestamp, data: items });
    } catch {
      // Malformed JSON — skip
    }
  }
  return reports;
}
