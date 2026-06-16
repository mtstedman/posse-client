// lib/display/helpers/formatters.js

import { C } from "../../../../../shared/format/functions/colors.js";
import { formatTokens, formatUsd } from "../../../../../shared/format/functions/units.js";
import { scrubSecrets } from "../../../../../shared/telemetry/classes/logging/secret-scrub.js";
export { displayColumnWidth, fit, stripAnsi } from "../../../../../shared/format/functions/ansi.js";
import { stripAnsi } from "../../../../../shared/format/functions/ansi.js";

export function formatConsoleArg(arg) {
  let text;
  if (typeof arg === "string") {
    text = arg;
  } else {
    try {
      text = JSON.stringify(arg);
    } catch {
      text = String(arg);
    }
  }
  if (text == null) text = "";
  text = scrubSecrets(text);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

export const _fmtTokens = formatTokens;
export const _fmtUsd = formatUsd;

export function _formatUsagePercent(value, max) {
  if (max == null || max <= 0 || value == null) return " --%";
  const pct = Math.max(0, Math.min(999, (value / max) * 100));
  if (pct === 0) return "  0%";
  if (pct < 1) return `${pct.toFixed(1).padStart(4)}%`;
  if (pct < 10) return `${pct.toFixed(1).padStart(4)}%`;
  return `${String(Math.round(pct)).padStart(3)}%`;
}

export function _buildMiniGauge(value, max, width = 8) {
  if (max == null || max <= 0 || value == null) return `${C.dim}${"\u2591".repeat(width)}${C.reset}`;
  const ratio = Math.max(0, Math.min(1, value / max));
  const partials = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"];
  const exact = ratio * width;
  const fullBlocks = Math.floor(exact);
  const remainder = exact - fullBlocks;
  const partialIndex = Math.max(0, Math.min(partials.length - 1, Math.round(remainder * (partials.length - 1))));
  const partialChar = fullBlocks < width ? (partials[partialIndex] || "") : "";
  const emptyBlocks = Math.max(width - fullBlocks - (partialChar ? 1 : 0), 0);
  return `${C.green}${"\u2588".repeat(fullBlocks)}${partialChar}${C.reset}${C.dim}${"\u2591".repeat(emptyBlocks)}${C.reset}`;
}

export function _buildUnknownGauge(width = 8) {
  return `${C.dim}${"\u2591".repeat(width)}${C.reset}`;
}

export function _buildPercentGauge(pct, width = 8) {
  const safeWidth = Math.max(8, width | 0);
  const ratio = Math.max(0, Math.min(1, Number(pct || 0) / 100));
  const filled = Math.max(0, Math.min(safeWidth, Math.round(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  return `${C.green}${"\u2588".repeat(filled)}${C.reset}${C.dim}${"\u2591".repeat(empty)}${C.reset}`;
}

export function _wrapQuestionBodyLines(text, width) {
  const wrapped = [];
  const safeWidth = Math.max(10, width);
  for (const rawLine of String(text || "").split("\n")) {
    if (rawLine.length === 0) {
      wrapped.push("");
      continue;
    }
    for (let pos = 0; pos < rawLine.length; pos += safeWidth) {
      wrapped.push(`   ${C.bold}${rawLine.slice(pos, pos + safeWidth)}${C.reset}`);
    }
  }
  return wrapped;
}

export function _sanitizeDisplayLine(text) {
  return String(text ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, "")
    // Allow only standard SGR sequences (numeric/semicolon parameters ending
    // in 'm'). The previous pass-through (`seq.endsWith("m")`) admitted
    // DEC-private-mode variants like ESC[?25m, which can flip terminal modes.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (seq) => /^\x1b\[[0-9;]*m$/.test(seq) ? seq : "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "")
    .replace(/\x1b(?!\[[0-9;]*m)/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\t/g, "  ");
}

export function _colorizeAssessorVerdictWords(text) {
  const raw = String(text ?? "");
  const normalized = stripAnsi(raw).toLowerCase();
  if (!normalized.includes("assessor")) return raw;
  return raw
    .replace(/\bPASS\b/g, `${C.green}PASS${C.reset}`)
    .replace(/\bFAIL\b/g, `${C.red}FAIL${C.reset}`);
}

export function _isNoisyStructuredStderr(text) {
  const normalized = String(text || "").replace(/^\[stderr\]\s*/i, "").trim();
  if (!normalized) return true;
  if (/^(output:|wall time:)/i.test(normalized)) return true;
  if (/^<stdin>:\d+:/i.test(normalized)) return true;
  if (/^At line:\d+\s+char:\d+/i.test(normalized)) return true;
  if (/^\+\s+~+/i.test(normalized)) return true;
  if (/^['"`].*operator\./i.test(normalized)) return true;
  if (/^(categoryinfo|fullyqualifiederrorid)\s*:/i.test(normalized)) return true;
  if (/^(traceback \(most recent call last\):|file ".*", line \d+)/i.test(normalized)) return true;
  if (/^[{}]$/.test(normalized)) return true;
  if (/^[\w$.()[\]]+\s*;\s*$/.test(normalized)) return true;
  if (/^(return\s+\w+\(|\w+\s*,\s*\d+\)?\s*)$/i.test(normalized)) return true;
  if (/^(from\s+\S+\s+import\s+\S+|import\s+\S+)$/i.test(normalized)) return true;
  if (/^(print|console\.log)\s*\(/i.test(normalized)) return true;
  if (/^(exist\.|exception|ception)$/i.test(normalized)) return true;
  if (/^missing expression after ','/i.test(normalized)) return true;
  if (/^get-content\s*:\s*cannot find path/i.test(normalized)) return true;
  if (/^(if|for|while|function)\b/i.test(normalized)) return true;
  if (/^\}\s*else\b/i.test(normalized)) return true;
  return false;
}

export function _isLowSignalStructuredMarker(text) {
  const normalized = String(text || "").trim();
  return /^\[(thread|turn|item)\.(started|completed)\]$/i.test(normalized)
    || /^\[(?:assessor|planner)\]\s*(?:success|completed)\s*:/i.test(normalized);
}

export function _isLowSignalAssessorMarker(text) {
  const normalized = String(text || "").trim();
  return /^(?:\[assessor\]\s*)?(?:success|completed)\s*:/i.test(normalized);
}

export function _isLowSignalWorkerCompletionMarker(text, role = null) {
  const normalized = String(text || "").trim();
  const workerRole = String(role || "").toLowerCase();
  if (workerRole === "assessor") {
    return _isLowSignalAssessorMarker(normalized);
  }
  if (workerRole === "planner") {
    return /^(?:\[planner\]\s*)?(?:success|completed)\s*:/i.test(normalized);
  }
  return /^\[(?:assessor|planner)\]\s*(?:success|completed)\s*:/i.test(normalized);
}
