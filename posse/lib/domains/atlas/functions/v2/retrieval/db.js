// @ts-check
//
// code.db - deterministic first-pass inventory of database SQL query sites.
// JS resolves the requested ATLAS paths; Rust owns source scanning and
// DB-query classification.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { nativeCodeDb } from "./native-evidence.js";
import { collectSurveyPaths } from "./survey.js";

const MAX_DB_FILES = 128;

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

  const data = nativeCodeDb({
    view,
    repoRoot,
    files: paths,
    selectedPaths: paths,
    requested,
    maxFiles,
    prefixTruncated,
  });
  return okEnvelope({ action, versionId, data });
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

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
