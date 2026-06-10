// @ts-check

import { isTerminalParseKind } from "../../../../atlas/functions/v2/parse/event-kinds.js";

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStage(row = {}) {
  const kind = String(row.kind || "");
  const lang = String(row.lang || "").trim();
  if (kind.includes(".discover.")) return "discover";
  if (kind.includes(".scip.stage.")) return lang ? `scip-${lang}` : "scip";
  if (kind.includes(".scip.ingest.")) return lang ? `scip-${lang}` : "scip";
  if (kind.includes(".merge.")) return lang ? `merge-${lang}` : "merge";
  if (kind.includes(".onnx.")) return "onnx-symbols";
  if (kind.includes(".parse.parse.") || kind.includes(".warm.parse.")) return lang ? `parse-${lang}` : "parse";
  if (!kind) return lang ? `parse-${lang}` : "parse";
  return lang ? `other-${lang}` : "other";
}

function parseStatus(row = {}) {
  const kind = String(row.kind || "");
  if (kind.endsWith(".failed")) return "failed";
  if (kind.endsWith(".skipped")) return "skipped";
  if (kind.endsWith(".completed")) return String(row.status || "completed");
  if (kind.includes(".scip.stage.")) return "staging";
  if (kind.includes(".scip.ingest.")) return "ingesting";
  if (kind.includes(".merge.")) return "merging";
  if (kind.includes(".onnx.")) return "background";
  if (kind.includes(".discover.")) return "scanning";
  return "running";
}

function progressText(row = {}) {
  const current = numeric(row.current);
  const total = numeric(row.total ?? row.totalSymbols ?? row.totalDocuments);
  if (current == null || total == null || total <= 0) return "";
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return `${pct}% ${current}/${total}`;
}

function detailText(row = {}) {
  const file = String(row.file || "").trim();
  const symbol = String(row.symbol || "").trim();
  const line = String(row.lastLine || "").trim();
  const labeled = [];
  if (file) labeled.push(`file=${file}`);
  if (symbol) labeled.push(`symbol=${symbol}`);
  if (labeled.length > 0) return labeled.join(" ");
  if (line) return line;
  const duration = numeric(row.durationMs);
  if (duration != null) return `${duration}ms`;
  const elapsed = numeric(row.elapsedMs);
  if (elapsed != null) return `${elapsed}ms elapsed`;
  return "";
}

export function truncateParseProgressLine(line, width) {
  const max = Math.max(1, Math.floor(Number(width) || 80));
  const text = String(line || "");
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}~`;
}

function padColumn(text, desiredWidth, frameWidth, fraction) {
  const value = String(text || "");
  const width = Math.max(1, Math.floor(Number(frameWidth) || 80));
  if (width < 32) return value;
  const columnWidth = Math.max(value.length, Math.min(desiredWidth, Math.floor(width * fraction)));
  return value.padEnd(columnWidth);
}

export function formatParseProgressRow(row = {}, { width = 100 } = {}) {
  const stage = padColumn(parseStage(row), 13, width, 0.25);
  const status = padColumn(parseStatus(row), 11, width, 0.2);
  const progress = progressText(row);
  const detail = detailText(row);
  const parts = [`  ${stage}`, status];
  if (progress) parts.push(progress);
  if (detail) parts.push(detail);
  return truncateParseProgressLine(parts.join("  ").replace(/\s+$/, ""), width);
}

export function formatParseSummary(summary = {}, { width = 100 } = {}) {
  const source = /** @type {Record<string, any>} */ (summary && typeof summary === "object" ? summary : {});
  const hasSummaryContent = source.branch != null ||
    source.seq != null ||
    source.totalFiles != null ||
    (source.totals && typeof source.totals === "object" && Object.keys(source.totals).length > 0);
  if (!hasSummaryContent) return "";
  const branch = String(source.branch || "repo").trim();
  const version = source.seq != null ? `${branch}@${source.seq}` : branch;
  const totals = source.totals && typeof source.totals === "object" ? source.totals : {};
  const entries = Object.entries(totals)
    .filter(([, count]) => Number(count) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const totalFiles = Number.isFinite(Number(source.totalFiles))
    ? Number(source.totalFiles)
    : entries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const bucketText = entries.map(([lang, count]) => `${lang}=${count}`).join(" ");
  const left = `atlas parse  ${version}`;
  const middle = totalFiles > 0 ? `${totalFiles} files` : "";
  return truncateParseProgressLine([left, middle, bucketText].filter(Boolean).join("  "), width);
}

export function renderParseBand({ rows = [], summary = {}, width = 100, maxRows = 8 } = {}) {
  const activeRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.active !== false && !isTerminalParseKind(String(row.kind || "")));
  if (activeRows.length === 0) return [];
  const limit = Math.max(1, Math.floor(Number(maxRows) || 8));
  const header = formatParseSummary(summary, { width });
  const lines = activeRows.slice(0, limit).map((row) => formatParseProgressRow(row, { width }));
  return header ? [header, ...lines] : lines;
}
