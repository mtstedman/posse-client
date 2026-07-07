// @ts-check
//
// code.persistence - deterministic first-pass inventory of durable writes.
// This intentionally stays pattern-based: it answers "where does this area
// write DB/file state?" cheaply before an agent escalates to raw windows.

import fs from "fs";
import path from "path";

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { collectSurveyPaths } from "./survey.js";
import { buildPathAmbiguity } from "./path-ambiguity.js";
import { buildNegativeEvidence } from "./negative-evidence.js";

const MAX_PERSISTENCE_FILES = 128;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITES = 400;

const SQL_PATTERNS = Object.freeze([
  { operation: "insert", re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "replace", re: /\bREPLACE\s+(?:OR\s+\w+\s+)?INTO\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "update", re: /\bUPDATE\s+(?:OR\s+\w+\s+)?[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "delete", re: /\bDELETE\s+FROM\s+[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
  { operation: "create_table", re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][\w.$-]*)[`"']?/gi },
]);

const FILE_PATTERNS = Object.freeze([
  { operation: "write_file", re: /\b(?:fs\.)?(?:writeFileSync|writeFile|promises\.writeFile)\s*\(/ },
  { operation: "append_file", re: /\b(?:fs\.)?(?:appendFileSync|appendFile|promises\.appendFile)\s*\(/ },
  { operation: "copy_file", re: /\b(?:fs\.)?(?:copyFileSync|copyFile|promises\.copyFile)\s*\(/ },
  { operation: "rename_file", re: /\b(?:fs\.)?(?:renameSync|rename|promises\.rename)\s*\(/ },
  { operation: "mkdir", re: /\b(?:fs\.)?(?:mkdirSync|mkdir|promises\.mkdir)\s*\(/ },
  { operation: "remove_file", re: /\b(?:fs\.)?(?:rmSync|rm|unlinkSync|unlink|promises\.rm|promises\.unlink)\s*\(/ },
  { operation: "php_write_file", re: /\bfile_put_contents\s*\(/ },
  { operation: "python_write_file", re: /\bopen\s*\([^,\n]+,\s*['"][wa+x]/ },
  { operation: "dataframe_write", re: /\.(?:to_csv|to_json|to_parquet|to_excel|save)\s*\(/ },
]);

// SQL keywords the patterns can mis-capture as a "target" from conflict/upsert
// clauses (e.g. `... DO UPDATE SET`, `UPDATE OR REPLACE`) but that are never
// real table names. Dropped so they do not surface as phantom writes.
const SQL_NON_TARGETS = new Set(["set", "from", "into", "values", "where", "select", "and", "or"]);

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").CodePersistenceParams,
 *   repoRoot?: string,
 * }} args
 */
export function codePersistence({ view, versionId, params = {}, repoRoot }) {
  const action = "code.persistence";
  const requested = normalizeRequested(params.paths ?? params.path);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.persistence requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, 64, 1, MAX_PERSISTENCE_FILES);
  const { paths, prefixTruncated } = collectSurveyPaths({ view, requested, maxFiles });
  const root = resolveRepoRoot(view, repoRoot);
  const warnings = prefixTruncated ? [`Path expansion reached the ${maxFiles}-file cap.`] : [];
  if (!root) warnings.push("Repo root was unavailable; persistence inventory could only report indexed paths, not file contents.");
  if (paths.length === 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        files: [],
        writes: [],
        exclusions: [],
        metrics: emptyMetrics(),
        truncated: prefixTruncated,
        warnings: [`No indexed files matched: ${requested.slice(0, 5).join(", ")}.`],
      },
    });
  }

  const writes = [];
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
    for (const write of scan.writes) {
      const key = `${write.kind}|${write.operation}|${write.target}|${write.site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      writes.push(write);
      if (writes.length >= MAX_WRITES) {
        truncated = true;
        break;
      }
    }
    if (writes.length >= MAX_WRITES) break;
  }

  const pathAmbiguity = buildPathAmbiguity({ view, repoRoot: root, paths, requested });
  if (pathAmbiguity?.warnings) warnings.push(.../** @type {string[]} */ (pathAmbiguity.warnings));
  const negativeEvidence = buildNegativeEvidence({ view, repoRoot: root, paths, requested, pathAmbiguity });
  if (negativeEvidence?.warnings) warnings.push(.../** @type {string[]} */ (negativeEvidence.warnings));

  const data = {
    files: fileRows,
    writes,
    exclusions: negativeEvidence?.candidates || [],
    metrics: {
      fileCount: fileRows.length,
      scannedFileCount: fileRows.filter((row) => row.scanned).length,
      writeCount: writes.length,
      dbWriteCount: writes.filter((row) => row.kind === "db").length,
      fileWriteCount: writes.filter((row) => row.kind === "file").length,
      durableResultCount: writes.filter((row) => row.classification === "durable_result").length,
      telemetryCount: writes.filter((row) => row.classification === "telemetry").length,
      bookkeepingCount: writes.filter((row) => row.classification === "bookkeeping").length,
      cacheCount: writes.filter((row) => row.classification === "cache").length,
    },
    truncated,
    warnings: [...new Set(warnings)],
  };
  if (pathAmbiguity) data.pathAmbiguity = pathAmbiguity;
  if (negativeEvidence) data.negativeEvidence = negativeEvidence;
  return okEnvelope({ action, versionId, data });
}

function scanFile({ repoRoot, repoPath }) {
  if (!repoRoot) return { scanned: false, byteSize: null, warning: "repo root unavailable", writes: [] };
  const abs = resolveUnderRoot(repoRoot, repoPath);
  if (!abs) return { scanned: false, byteSize: null, warning: "path escaped repo root", writes: [] };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { scanned: false, byteSize: null, warning: "file not present on disk", writes: [] };
  }
  if (!stat.isFile()) return { scanned: false, byteSize: stat.size, warning: "not a regular file", writes: [] };
  if (stat.size > MAX_READ_BYTES) return { scanned: false, byteSize: stat.size, warning: "file too large for persistence scan", writes: [] };
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { scanned: false, byteSize: stat.size, warning: "could not read file as text", writes: [] };
  }
  return { scanned: true, byteSize: stat.size, warning: null, writes: scanText(repoPath, text) };
}

function scanText(repoPath, text) {
  const writes = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const window = lines.slice(i, Math.min(lines.length, i + 6)).join(" ");
    if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE)\b/i.test(line)) {
      const isUpsert = /ON\s+(?:CONFLICT|DUPLICATE)\b/i.test(window) || /\bINSERT\s+OR\s+REPLACE\b/i.test(line);
      const sqlMatches = [];
      for (const pattern of SQL_PATTERNS) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(line))) {
          const target = normalizeTarget(match[1]);
          if (!target || SQL_NON_TARGETS.has(target.toLowerCase())) continue;
          const operation = isUpsert && pattern.operation === "insert" ? "upsert" : pattern.operation;
          sqlMatches.push({ operation, target });
        }
      }
      // `INSERT OR REPLACE INTO x` matches both the insert and replace patterns;
      // keep only the insert/upsert write so one statement is not counted twice.
      const insertTargets = new Set(
        sqlMatches.filter((m) => m.operation === "insert" || m.operation === "upsert").map((m) => m.target.toLowerCase()),
      );
      for (const { operation, target } of sqlMatches) {
        if (operation === "replace" && insertTargets.has(target.toLowerCase())) continue;
        writes.push({
          kind: "db",
          operation,
          target,
          path: repoPath,
          line: i + 1,
          site: `${repoPath}:${i + 1}`,
          classification: classifyPersistenceTarget(target, repoPath),
          confidence: "pattern",
          evidence: compactEvidence(line || window),
        });
      }
    }
    for (const pattern of FILE_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      const target = extractFileTarget(line) || "<dynamic>";
      writes.push({
        kind: "file",
        operation: pattern.operation,
        target,
        path: repoPath,
        line: i + 1,
        site: `${repoPath}:${i + 1}`,
        classification: classifyPersistenceTarget(target, repoPath),
        confidence: "pattern",
        evidence: compactEvidence(line),
      });
    }
  }
  return writes;
}

function classifyPersistenceTarget(target, repoPath = "") {
  const text = `${target} ${repoPath}`.toLowerCase();
  if (/(observation|event|agent_call|telemetry|metric|usage|log|trace|probe)/.test(text)) return "telemetry";
  if (/(job|attempt|queue|lease|lock|process|batch|schedule|scheduler|review_gate|bookkeep)/.test(text)) return "bookkeeping";
  if (/(cache|blob|tmp|temp|scratch|snapshot|memo|embedding|ohlcv|fact|universe)/.test(text)) return "cache";
  if (/(artifact|result|score|grade|composite|recording|ingest|stream|publish|order|invoice|user|account)/.test(text)) return "durable_result";
  return "unknown";
}

function extractFileTarget(line) {
  const open = line.indexOf("(");
  const tail = open === -1 ? line : line.slice(open + 1);
  // Prefer reconstructing a path.join(...) target; a bare quoted match would
  // otherwise grab only the first join segment (e.g. "a" from join(root,"a","b")).
  const joined = tail.match(/path\.join\s*\(([^)]{1,240})\)/);
  if (joined?.[1]) {
    const pieces = [...joined[1].matchAll(/["'`]([^"'`]{1,120})["'`]/g)].map((match) => match[1]).filter(Boolean);
    if (pieces.length > 0) return normalizeTarget(pieces.join("/"));
  }
  const quoted = tail.match(/["'`]([^"'`]{1,240})["'`]/);
  if (quoted?.[1]) return normalizeTarget(quoted[1]);
  return "";
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
    writeCount: 0,
    dbWriteCount: 0,
    fileWriteCount: 0,
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
