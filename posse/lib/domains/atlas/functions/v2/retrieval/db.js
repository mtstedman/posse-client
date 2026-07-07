// @ts-check
//
// code.db - deterministic first-pass inventory of database SQL query sites.
// This intentionally stays pattern-based: it surfaces SQL/query touchpoints
// that the symbol graph does not naturally expose before raw-window escalation.

import fs from "fs";
import path from "path";

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { collectSurveyPaths } from "./survey.js";
import { buildPathAmbiguity } from "./path-ambiguity.js";
import { buildNegativeEvidence } from "./negative-evidence.js";

const MAX_DB_FILES = 128;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_SITES = 400;

const SQL_PATTERNS = Object.freeze([
  { operation: "select", access: "read", re: /\bSELECT\b.{0,320}?\bFROM\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "insert", access: "write", re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "replace", access: "write", re: /\bREPLACE\s+(?:OR\s+\w+\s+)?INTO\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "update", access: "write", re: /\bUPDATE\s+(?:OR\s+\w+\s+)?[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "delete", access: "write", re: /\bDELETE\s+FROM\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "create_table", access: "schema", re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "alter_table", access: "schema", re: /\bALTER\s+TABLE\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "drop_table", access: "schema", re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
]);

// SQL keywords the patterns can mis-capture as a "target" from conflict/upsert
// clauses (e.g. `... DO UPDATE SET`, `UPDATE OR REPLACE`) but that are never
// real table names. Dropped so they do not surface as phantom query sites.
const SQL_NON_TARGETS = new Set(["set", "from", "into", "values", "where", "select", "and", "or"]);

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").CodeDbParams,
 *   repoRoot?: string,
 * }} args
 */
export function codeDb({ view, versionId, params = {}, repoRoot }) {
  const action = "code.db";
  const requested = normalizeRequested(params.paths ?? params.path);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.db requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, 64, 1, MAX_DB_FILES);
  const { paths, prefixTruncated } = collectSurveyPaths({ view, requested, maxFiles });
  const root = resolveRepoRoot(view, repoRoot);
  const warnings = prefixTruncated ? [`Path expansion reached the ${maxFiles}-file cap.`] : [];
  if (!root) warnings.push("Repo root was unavailable; DB inventory could only report indexed paths, not file contents.");
  if (paths.length === 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        files: [],
        queries: [],
        exclusions: [],
        metrics: emptyMetrics(),
        truncated: prefixTruncated,
        warnings: [`No indexed files matched: ${requested.slice(0, 5).join(", ")}.`],
      },
    });
  }

  const queries = [];
  const seen = new Set();
  const fileRows = [];
  let truncated = prefixTruncated;
  for (const repoPath of paths) {
    const scan = scanFile({ repoRoot: root, repoPath });
    fileRows.push({
      path: repoPath,
      scanned: scan.scanned,
      byteSize: scan.byteSize,
      warning: scan.warning || null,
    });
    if (scan.warning) warnings.push(`${repoPath}: ${scan.warning}`);
    for (const query of scan.queries) {
      const key = `${query.access}|${query.operation}|${query.target}|${query.site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(query);
      if (queries.length >= MAX_QUERY_SITES) {
        truncated = true;
        break;
      }
    }
    if (queries.length >= MAX_QUERY_SITES) break;
  }

  const pathAmbiguity = buildPathAmbiguity({ view, repoRoot: root, paths, requested });
  if (pathAmbiguity?.warnings) warnings.push(.../** @type {string[]} */ (pathAmbiguity.warnings));
  const negativeEvidence = buildNegativeEvidence({ view, repoRoot: root, paths, requested, pathAmbiguity });
  if (negativeEvidence?.warnings) warnings.push(.../** @type {string[]} */ (negativeEvidence.warnings));

  const data = {
    files: fileRows,
    queries,
    exclusions: negativeEvidence?.candidates || [],
    metrics: {
      fileCount: fileRows.length,
      scannedFileCount: fileRows.filter((row) => row.scanned).length,
      queryCount: queries.length,
      dbReadCount: queries.filter((row) => row.access === "read").length,
      dbWriteCount: queries.filter((row) => row.access === "write").length,
      dbSchemaCount: queries.filter((row) => row.access === "schema").length,
      durableResultCount: queries.filter((row) => row.classification === "durable_result").length,
      telemetryCount: queries.filter((row) => row.classification === "telemetry").length,
      bookkeepingCount: queries.filter((row) => row.classification === "bookkeeping").length,
      cacheCount: queries.filter((row) => row.classification === "cache").length,
    },
    truncated,
    warnings: [...new Set(warnings)],
  };
  if (pathAmbiguity) data.pathAmbiguity = pathAmbiguity;
  if (negativeEvidence) data.negativeEvidence = negativeEvidence;
  return okEnvelope({ action, versionId, data });
}

function scanFile({ repoRoot, repoPath }) {
  if (!repoRoot) return { scanned: false, byteSize: null, warning: "repo root unavailable", queries: [] };
  const abs = resolveUnderRoot(repoRoot, repoPath);
  if (!abs) return { scanned: false, byteSize: null, warning: "path escaped repo root", queries: [] };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { scanned: false, byteSize: null, warning: "file not present on disk", queries: [] };
  }
  if (!stat.isFile()) return { scanned: false, byteSize: stat.size, warning: "not a regular file", queries: [] };
  if (stat.size > MAX_READ_BYTES) return { scanned: false, byteSize: stat.size, warning: "file too large for DB scan", queries: [] };
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { scanned: false, byteSize: stat.size, warning: "could not read file as text", queries: [] };
  }
  return { scanned: true, byteSize: stat.size, warning: null, queries: scanText(repoPath, text) };
}

function scanText(repoPath, text) {
  const queries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const window = lines.slice(i, Math.min(lines.length, i + 6)).join(" ");
    if (/\b(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(line)) {
      const isUpsert = /ON\s+(?:CONFLICT|DUPLICATE)\b/i.test(window) || /\bINSERT\s+OR\s+REPLACE\b/i.test(line);
      const sqlMatches = [];
      for (const pattern of SQL_PATTERNS) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(line))) {
          const target = normalizeTarget(match[1]);
          if (!target || SQL_NON_TARGETS.has(target.toLowerCase())) continue;
          const operation = isUpsert && pattern.operation === "insert" ? "upsert" : pattern.operation;
          const access = operation === "upsert" ? "write" : pattern.access;
          sqlMatches.push({ operation, access, target });
        }
      }
      // `INSERT OR REPLACE INTO x` matches both the insert and replace patterns;
      // keep only the insert/upsert site so one statement is not counted twice.
      const insertTargets = new Set(
        sqlMatches.filter((m) => m.operation === "insert" || m.operation === "upsert").map((m) => m.target.toLowerCase()),
      );
      for (const { operation, access, target } of sqlMatches) {
        if (operation === "replace" && insertTargets.has(target.toLowerCase())) continue;
        queries.push({
          kind: "db",
          access,
          operation,
          target,
          path: repoPath,
          line: i + 1,
          site: `${repoPath}:${i + 1}`,
          classification: classifyDbTarget(target, repoPath),
          confidence: "pattern",
          evidence: compactEvidence(line || window),
        });
      }
    }
  }
  return queries;
}

function classifyDbTarget(target, repoPath = "") {
  const text = `${target} ${repoPath}`.toLowerCase();
  if (/(observation|event|agent_call|telemetry|metric|usage|log|trace|probe)/.test(text)) return "telemetry";
  if (/(job|attempt|queue|lease|lock|process|batch|schedule|scheduler|review_gate|bookkeep)/.test(text)) return "bookkeeping";
  if (/(cache|blob|tmp|temp|scratch|snapshot|memo|embedding|ohlcv|fact|universe)/.test(text)) return "cache";
  if (/(artifact|result|score|grade|composite|recording|ingest|stream|publish|order|invoice|user|account)/.test(text)) return "durable_result";
  return "unknown";
}

function normalizeTarget(value) {
  return String(value ?? "").trim().replace(/[`"'[\]]/g, "").replace(/\\/g, "/").replace(/;+$/, "");
}

function compactEvidence(line) {
  return String(line || "").trim().replace(/\s+/g, " ").slice(0, 240);
}

function emptyMetrics() {
  return {
    fileCount: 0,
    scannedFileCount: 0,
    queryCount: 0,
    dbReadCount: 0,
    dbWriteCount: 0,
    dbSchemaCount: 0,
    durableResultCount: 0,
    telemetryCount: 0,
    bookkeepingCount: 0,
    cacheCount: 0,
  };
}

function normalizeRequested(raw) {
  return (Array.isArray(raw) ? raw : [raw])
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function normalizeRepoPath(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!text || text === "." || text.startsWith("../") || text.includes("/../") || /^[a-zA-Z]:\//.test(text)) return "";
  return text;
}

function resolveRepoRoot(view, repoRoot) {
  const raw = repoRoot || (typeof view.meta === "function" ? /** @type {any} */ (view.meta()).repo_root : "");
  if (!raw) return "";
  try {
    const resolved = path.resolve(String(raw));
    return fs.existsSync(resolved) ? resolved : "";
  } catch {
    return "";
  }
}

function resolveUnderRoot(repoRoot, repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized) return "";
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return "";
  return resolved;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
