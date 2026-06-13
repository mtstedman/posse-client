// @ts-check
//
// file.read handler. Reads a non-indexed file (e.g. JSON, YAML, config)
// with optional search + jsonPath extraction.

import { okEnvelope, errorEnvelope } from "./envelope.js";
import { isCanonicalRepoPath } from "../paths.js";
import { redactSecrets, redactSecretsLines } from "./redaction.js";

/** @typedef {import("../contracts/tool-params.js").FileReadParams} FileReadParams */
/** @typedef {import("../contracts/tool-results.js").FileReadData} FileReadData */
/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {(path: string) => string | null} ReadFile */

const DEFAULT_MAX_BYTES = 512 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES = 1000;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_PATTERN_CHARS = 200;
const MAX_SEARCH_LINE_CHARS = 20_000;
const SEARCH_TIME_BUDGET_MS = 500;
const BLOCKED_JSON_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {{
 *   versionId: string,
 *   params: FileReadParams,
 *   readFile: ReadFile,
 *   view?: View,
 * }} args
 */
export function fileRead({ versionId, params, readFile, view }) {
  if (!params.filePath || !isCanonicalRepoPath(params.filePath)) {
    return errorEnvelope({
      action: "file.read",
      versionId,
      code: "invalid_path",
      message: `file.read requires a canonical repo-relative filePath, got ${params.filePath}`,
    });
  }

  if (isIndexedSourceWholeFileRead({ view, params })) {
    return errorEnvelope({
      action: "file.read",
      versionId,
      code: "policy_downgrade",
      message: "file.read is limited for indexed source files; use ATLAS code tools for source bodies.",
      details: {
        nextBestAction: "Use code.getSkeleton, code.getHotPath, or code.needWindow for this indexed source file.",
        filePath: params.filePath,
      },
    });
  }

  const source = readFile(params.filePath);
  if (source == null) {
    return errorEnvelope({
      action: "file.read",
      versionId,
      code: "file_unreadable",
      message: `Could not read ${params.filePath}`,
    });
  }

  const totalBytes = Buffer.byteLength(source, "utf8");
  const requestedMaxBytes = typeof params.maxBytes === "number" && params.maxBytes > 0
    ? Math.min(params.maxBytes, HARD_MAX_BYTES)
    : DEFAULT_MAX_BYTES;
  if (totalBytes > HARD_MAX_BYTES && !params.search && !params.jsonPath && params.limit == null) {
    return errorEnvelope({
      action: "file.read",
      versionId,
      code: "size_exceeded",
      message: `file.read refuses to return ${totalBytes} bytes without a line/search/jsonPath bound.`,
      details: {
        maxBytes: HARD_MAX_BYTES,
        nextBestAction: "Retry with limit, search, jsonPath, or maxBytes.",
      },
    });
  }
  const allLines = source.split(/\r?\n/);
  const totalLines = allLines.length;
  const offset = typeof params.offset === "number" && params.offset > 0 ? params.offset : 0;
  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? Math.min(params.limit, DEFAULT_MAX_LINES)
      : Math.min(totalLines - offset, DEFAULT_MAX_LINES);
  const lines = allLines.slice(offset, offset + limit);

  let content = redactSecrets(lines.join("\n"));
  let truncated = offset + lines.length < totalLines;
  const buf = Buffer.from(content, "utf8");
  if (buf.length > requestedMaxBytes) {
    content = buf.subarray(0, requestedMaxBytes).toString("utf8");
    truncated = true;
  }

  /** @type {FileReadData} */
  const data = {
    repo_rel_path: params.filePath,
    content,
    totalBytes,
    totalLines,
    returnedLines: lines.length,
    startLine: offset + 1,
    truncated,
  };

  if (params.search) {
    const compiled = compileSearchPattern(params.search);
    if (compiled.ok === false) {
      return errorEnvelope({
        action: "file.read",
        versionId,
        code: compiled.code,
        message: compiled.message,
      });
    }
    const re = compiled.re;
    try {
      // Touch once so invalid engines fail before we start scanning.
      re.test("");
    } catch (err) {
      return errorEnvelope({
        action: "file.read",
        versionId,
        code: "invalid_regex",
        message: `Invalid search regex: ${err.message}`,
      });
    }
    const ctxLines = typeof params.searchContext === "number" ? params.searchContext : 2;
    /** @type {number[]} */
    const matchLines = [];
    const searchStartedAt = Date.now();
    for (let li = 0; li < lines.length; li++) {
      if (Date.now() - searchStartedAt > SEARCH_TIME_BUDGET_MS) {
        data.searchTimedOut = true;
        truncated = true;
        data.truncated = true;
        break;
      }
      const searchableLine = lines[li].length > MAX_SEARCH_LINE_CHARS
        ? lines[li].slice(0, MAX_SEARCH_LINE_CHARS)
        : lines[li];
      if (re.test(searchableLine)) {
        matchLines.push(li);
        if (matchLines.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
    // One native redaction call for the whole window instead of one per
    // matched line plus one per context line (each sync call is a spawn).
    const redactedLines = matchLines.length > 0 ? redactSecretsLines(lines) : lines;
    data.matches = matchLines.map((li) => ({
      line: offset + li + 1,
      text: redactedLines[li],
      context: {
        before: redactedLines.slice(Math.max(0, li - ctxLines), li),
        after: redactedLines.slice(li + 1, Math.min(lines.length, li + 1 + ctxLines)),
      },
    }));
  }

  if (params.jsonPath) {
    try {
      const parsed = JSON.parse(source);
      data.jsonPathValue = extractJsonPath(parsed, params.jsonPath);
    } catch {
      // Tolerate non-JSON; jsonPathValue omitted.
    }
  }

  return okEnvelope({ action: "file.read", versionId, data });
}

/**
 * @param {{ view?: View, params: FileReadParams }} args
 * @returns {boolean}
 */
function isIndexedSourceWholeFileRead({ view, params }) {
  if (!view) return false;
  if (params.search || params.jsonPath || params.offset != null || params.limit != null) return false;
  if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|cpp|cc|cxx|c|h|hpp|php|kt|kts|sh)$/i.test(params.filePath)) {
    return false;
  }
  try {
    return view.query.symbolsInFile(params.filePath).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} pattern
 * @returns {{ ok: true, re: RegExp } | { ok: false, code: string, message: string }}
 */
function compileSearchPattern(pattern) {
  const raw = String(pattern || "");
  if (raw.length > MAX_SEARCH_PATTERN_CHARS) {
    return {
      ok: false,
      code: "search_too_large",
      message: `file.read search pattern exceeds ${MAX_SEARCH_PATTERN_CHARS} characters`,
    };
  }
  const source = looksReDosProne(raw) ? escapeRegExp(raw) : raw;
  try {
    return { ok: true, re: new RegExp(source, "i") };
  } catch (err) {
    return {
      ok: false,
      code: "invalid_regex",
      message: `Invalid search regex: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Very small guard for common catastrophic-backtracking shapes. Suspicious
 * patterns are treated as literal text rather than evaluated as regexes.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
function looksReDosProne(pattern) {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
    || /(\.\*){3,}/.test(pattern)
    || /\[[^\]]+\][+*]\s*[+*{]/.test(pattern);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal dotted-path extractor: `foo.bar.0.baz`. Returns undefined when
 * the path does not resolve.
 *
 * @param {unknown} root
 * @param {string} jsonPath
 * @returns {unknown}
 */
function extractJsonPath(root, jsonPath) {
  const segments = jsonPath.split(".").filter(Boolean);
  let cur = root;
  for (const seg of segments) {
    if (BLOCKED_JSON_PATH_SEGMENTS.has(seg)) return undefined;
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      cur = /** @type {any} */ (cur)[seg];
    }
  }
  return cur;
}
